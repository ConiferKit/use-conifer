// agent.ts — the Layer A core: an Agent owns a model, instructions, and a
// tool surface, and run() drives the chat/tool loop against the gateway,
// aggregating costs from receipts into a budget the caller can trust.

import { Conifer, textOf, type ChatRequest, type Completion, type Message } from "conifer-sdk";
import { emptyAggregate, foldAggregate, recordCall } from "./receipts.ts";
import { preflightTools, DEFAULT_TOOL_CAP } from "./limits.ts";
import { AgentError, BudgetExceededError, MaxTurnsError } from "./errors.ts";
import type { AggregateReceipt, AgentTool, NanoUsd, RunOptions, RunResult } from "./types.ts";
import type { HookSet } from "./hooks.ts";

/**
 * The minimal chat surface an Agent needs. `Conifer` satisfies it, and so
 * does any fake with an async `chat()` — injection never requires the full
 * client class (or a CONIFER_API_KEY).
 */
export interface ChatClient {
  chat(request: ChatRequest): Promise<Completion>;
}

export interface AgentConfig {
  name: string;
  model: string;
  instructions?: string;
  tools?: AgentTool[];
  /** Hard cap on chat turns per run. Default 12. */
  maxTurns?: number;
  /** Budget for the whole run, enforced from settled receipts. */
  maxCostNanoUsd?: NanoUsd;
  /** Tool-surface cap. Default DEFAULT_TOOL_CAP. */
  toolLimit?: number;
  /** Injected client; defaults to `new Conifer()` lazily inside run(). */
  client?: ChatClient;
  /** Lifecycle hooks: sessionStart/End, preToolCall (block or rewrite), postToolCall. */
  hooks?: HookSet;
}

/** The wire shape of an incoming tool call on an assistant message. */
interface ToolCallWire {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export class Agent {
  readonly name: string;
  readonly model: string;
  readonly instructions?: string;
  readonly maxCostNanoUsd?: NanoUsd;
  /** Mutable on purpose: tests and callers may swap in a different client. */
  client?: ChatClient;

  private readonly tools: AgentTool[];
  private readonly maxTurns: number;
  private readonly toolLimit: number;
  private readonly hooks?: HookSet;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.instructions = config.instructions;
    this.maxCostNanoUsd = config.maxCostNanoUsd;
    this.client = config.client;
    this.tools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 12;
    this.toolLimit = config.toolLimit ?? DEFAULT_TOOL_CAP;
    this.hooks = config.hooks;
  }

  async run(input: string, options: RunOptions = {}): Promise<RunResult> {
    // Lazy default: only construct Conifer when nothing was injected, so
    // building an Agent never needs CONIFER_API_KEY.
    const client = (this.client ??= new Conifer());

    // A caller-supplied cap (asTool passing down the tree's remaining budget)
    // tightens — never loosens — this agent's own configured budget.
    const cap = options.budgetCapNanoUsd;
    const budget = this.maxCostNanoUsd !== undefined && cap !== undefined
      ? Math.min(this.maxCostNanoUsd, cap)
      : cap ?? this.maxCostNanoUsd;

    const agg = emptyAggregate();
    const { warnings } = preflightTools(this.name, this.tools, this.toolLimit);
    for (const w of warnings) {
      options.onEvent?.({ type: "tool_surface_warning", agent: this.name, ...w });
    }

    const wireTools = this.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const messages: Message[] = [];
    if (this.instructions) messages.push({ role: "system", content: this.instructions });
    messages.push({ role: "user", content: input });

    let warnedBudget = false;

    await this.hooks?.sessionStart?.({ agent: this.name, input });

    let turn = 0;
    let turnsDone = 0;
    try {
      for (turn = 1; ; turn++) {
        if (options.signal?.aborted) throw new AgentError(`agent "${this.name}" run aborted`, agg);
        if (turn > this.maxTurns) {
          throw new MaxTurnsError({ maxTurns: this.maxTurns, receipt: agg, agent: this.name });
        }

        let remaining: NanoUsd | undefined;
        if (budget !== undefined) {
          remaining = budget - agg.totalCostNanoUsd;
          // Exhausted outright, or the remainder cannot cover a call like the
          // last one — the gateway's hard `maxCostNanoUsd` ceiling would refuse
          // such a call anyway, so fail cleanly here with the receipt intact.
          const lastCost = agg.calls.at(-1)?.costNanoUsd;
          if (remaining <= 0 || (lastCost !== undefined && remaining < lastCost)) {
            throw new BudgetExceededError({
              budgetNanoUsd: budget, receipt: agg, agent: this.name,
            });
          }
        }

        options.onEvent?.({ type: "turn_start", agent: this.name, turn });

        const completion = await client.chat({
          model: this.model,
          messages,
          ...(wireTools.length > 0 ? { tools: wireTools } : {}),
          ...(remaining !== undefined ? { maxCostNanoUsd: remaining } : {}),
        });

        recordCall(agg, {
          agent: this.name,
          model: this.model,
          costNanoUsd: completion.receipt?.costNanoUsd,
          requestId: completion.id,
        });

        options.onEvent?.({ type: "model_response", agent: this.name, turn, completion });
        turnsDone = turn;

        if (budget !== undefined && !warnedBudget
          && agg.totalCostNanoUsd >= budget * 0.8) {
          warnedBudget = true;
          options.onEvent?.({
            type: "budget_warning", agent: this.name,
            spentNanoUsd: agg.totalCostNanoUsd, budgetNanoUsd: budget,
          });
        }

        const choice = completion.choices[0];
        const toolCalls = choice?.message?.tool_calls as ToolCallWire[] | undefined;
        if (toolCalls && toolCalls.length > 0) {
          // conifer-sdk's Message carries an index signature, so tool_calls on
          // an assistant message is representable without widening.
          messages.push({
            role: "assistant",
            content: choice?.message?.content ?? "",
            tool_calls: toolCalls,
          } as Message);
          const results = await Promise.all(
            toolCalls.map((tc) => this.dispatch(tc, options, agg, budget)),
          );
          for (const r of results) {
            messages.push({ role: "tool", content: r.content, tool_call_id: r.id } as Message);
          }
          continue;
        }

        const output = textOf(completion) ?? "";
        options.onEvent?.({
          type: "run_end", agent: this.name, turns: turn, costNanoUsd: agg.totalCostNanoUsd,
        });
        const result: RunResult = { output, receipt: agg, turns: turn, messages };
        await this.hooks?.sessionEnd?.({ agent: this.name, result });
        return result;
      }
    } catch (err) {
      // Terminal error path (BudgetExceededError, MaxTurnsError, abort, …):
      // still emit run_end and fire sessionEnd with a partial RunResult so
      // observers see turns and cost so far. A throwing sessionEnd must never
      // mask the original error, so its failures are swallowed here.
      options.onEvent?.({
        type: "run_end", agent: this.name, turns: turnsDone, costNanoUsd: agg.totalCostNanoUsd,
      });
      try {
        await this.hooks?.sessionEnd?.({
          agent: this.name,
          result: { output: "", receipt: agg, turns: turnsDone, messages },
        });
      } catch { /* swallowed: the original error wins */ }
      throw err;
    }
  }

  /**
   * Execute one tool call. Failures — unknown tool, unparseable arguments,
   * a throwing execute() — become error result strings fed back to the
   * model, never a crash of the run.
   */
  private async dispatch(
    tc: ToolCallWire, options: RunOptions, agg: AggregateReceipt, budget?: NanoUsd,
  ): Promise<{ id: string; content: string }> {
    const name = tc.function?.name ?? "";

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(tc.function?.arguments || "{}");
      args = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (err) {
      const content = `Error: tool "${name}" received invalid JSON arguments: ${
        err instanceof Error ? err.message : String(err)}`;
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
      return { id: tc.id, content };
    }

    options.onEvent?.({ type: "tool_call", agent: this.name, tool: name, args });

    // preToolCall may block the call (skipping execution) or rewrite its args.
    if (this.hooks?.preToolCall) {
      const out = await this.hooks.preToolCall({ agent: this.name, tool: name, args });
      if (out?.block !== undefined) {
        const content = `Blocked by hook: ${out.block}`;
        options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
        await this.hooks.postToolCall?.({ agent: this.name, tool: name, args, result: content, isError: true });
        return { id: tc.id, content };
      }
      if (out?.args) args = out.args;
    }

    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const content = `Error: unknown tool "${name}"`;
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
      await this.hooks?.postToolCall?.({ agent: this.name, tool: name, args, result: content, isError: true });
      return { id: tc.id, content };
    }

    try {
      const result = await tool.execute(args, {
        signal: options.signal,
        agentName: this.name,
        // Subagent plumbing: fold merges a child run's settled costs into
        // this run's aggregate; onEvent lets nested runs surface events.
        fold: (child) => foldAggregate(agg, child),
        onEvent: options.onEvent,
        // Tree-budget plumbing: what this run can still afford, so a subagent
        // tool caps its child run and one delegation cannot blow the tree.
        ...(budget !== undefined
          ? { remainingBudgetNanoUsd: budget - agg.totalCostNanoUsd }
          : {}),
      });
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result, isError: false });
      await this.hooks?.postToolCall?.({ agent: this.name, tool: name, args, result, isError: false });
      return { id: tc.id, content: result };
    } catch (err) {
      const content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
      await this.hooks?.postToolCall?.({ agent: this.name, tool: name, args, result: content, isError: true });
      // A budget overrun is a terminal condition for the whole tree: it must
      // propagate (with its receipt) rather than be papered over as a tool
      // result string the model could shrug at.
      if (err instanceof BudgetExceededError) throw err;
      return { id: tc.id, content };
    }
  }

  /**
   * Expose this agent as a tool another agent can call. The child's whole
   * run happens inside one parent tool call; its aggregate is folded into
   * the parent's via `ctx.fold`.
   *
   * Budgets: the child runs under an effective budget = min(its own
   * `maxCostNanoUsd` if set, the parent tree's remaining headroom via
   * `ctx.remainingBudgetNanoUsd`), so a single delegation can never exceed
   * the tree budget inside one tool call. A child BudgetExceededError folds
   * the child's settled spend into the parent and then propagates.
   */
  asTool(opts: { name?: string; description?: string } = {}): AgentTool {
    const name = opts.name ?? this.name;
    const description = opts.description
      ?? `Delegate a task to the "${this.name}" agent. ${(this.instructions ?? "").slice(0, 200)}`.trim();
    return {
      name,
      description,
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "The task for the subagent" } },
        required: ["task"],
      },
      source: "subagent",
      execute: async (args, ctx) => {
        ctx.onEvent?.({ type: "subagent_start", agent: ctx.agentName, subagent: this.name });
        try {
          const childRun = await this.run(String(args.task ?? ""), {
            signal: ctx.signal,
            onEvent: ctx.onEvent,
            ...(ctx.remainingBudgetNanoUsd !== undefined
              ? { budgetCapNanoUsd: ctx.remainingBudgetNanoUsd }
              : {}),
          });
          ctx.fold?.(childRun.receipt);
          ctx.onEvent?.({
            type: "subagent_end", agent: ctx.agentName, subagent: this.name,
            costNanoUsd: childRun.receipt.totalCostNanoUsd,
          });
          return childRun.output;
        } catch (err) {
          // The child's settled spend must reach the parent's aggregate even
          // when the child run fails; its receipt rides on the error.
          if (err instanceof AgentError) ctx.fold?.(err.receipt);
          throw err;
        }
      },
    };
  }
}
