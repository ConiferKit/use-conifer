// agent.ts — the Layer A core: an Agent owns a model, instructions, and a
// tool surface, and run() drives the chat/tool loop against the gateway,
// aggregating costs from receipts into a budget the caller can trust.

import { Conifer, textOf, type ChatRequest, type Completion, type Message } from "conifer-sdk";
import { emptyAggregate, recordCall } from "./receipts.ts";
import { preflightTools, DEFAULT_TOOL_CAP } from "./limits.ts";
import { AgentError, BudgetExceededError, MaxTurnsError } from "./errors.ts";
import type { AgentTool, NanoUsd, RunOptions, RunResult } from "./types.ts";

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
  /** Wired in Task 5. The field exists now so configs carry it forward. */
  hooks?: unknown;
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

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.instructions = config.instructions;
    this.maxCostNanoUsd = config.maxCostNanoUsd;
    this.client = config.client;
    this.tools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 12;
    this.toolLimit = config.toolLimit ?? DEFAULT_TOOL_CAP;
  }

  async run(input: string, options: RunOptions = {}): Promise<RunResult> {
    // Lazy default: only construct Conifer when nothing was injected, so
    // building an Agent never needs CONIFER_API_KEY.
    const client = (this.client ??= new Conifer());

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

    for (let turn = 1; ; turn++) {
      if (options.signal?.aborted) throw new AgentError(`agent "${this.name}" run aborted`, agg);
      if (turn > this.maxTurns) {
        throw new MaxTurnsError({ maxTurns: this.maxTurns, receipt: agg, agent: this.name });
      }

      let remaining: NanoUsd | undefined;
      if (this.maxCostNanoUsd !== undefined) {
        remaining = this.maxCostNanoUsd - agg.totalCostNanoUsd;
        // Exhausted outright, or the remainder cannot cover a call like the
        // last one — the gateway's hard `maxCostNanoUsd` ceiling would refuse
        // such a call anyway, so fail cleanly here with the receipt intact.
        const lastCost = agg.calls.at(-1)?.costNanoUsd;
        if (remaining <= 0 || (lastCost !== undefined && remaining < lastCost)) {
          throw new BudgetExceededError({
            budgetNanoUsd: this.maxCostNanoUsd, receipt: agg, agent: this.name,
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

      if (this.maxCostNanoUsd !== undefined && !warnedBudget
        && agg.totalCostNanoUsd >= this.maxCostNanoUsd * 0.8) {
        warnedBudget = true;
        options.onEvent?.({
          type: "budget_warning", agent: this.name,
          spentNanoUsd: agg.totalCostNanoUsd, budgetNanoUsd: this.maxCostNanoUsd,
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
        const results = await Promise.all(toolCalls.map((tc) => this.dispatch(tc, options)));
        for (const r of results) {
          messages.push({ role: "tool", content: r.content, tool_call_id: r.id } as Message);
        }
        continue;
      }

      const output = textOf(completion) ?? "";
      options.onEvent?.({
        type: "run_end", agent: this.name, turns: turn, costNanoUsd: agg.totalCostNanoUsd,
      });
      return { output, receipt: agg, turns: turn, messages };
    }
  }

  /**
   * Execute one tool call. Failures — unknown tool, unparseable arguments,
   * a throwing execute() — become error result strings fed back to the
   * model, never a crash of the run.
   */
  private async dispatch(
    tc: ToolCallWire, options: RunOptions,
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

    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const content = `Error: unknown tool "${name}"`;
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
      return { id: tc.id, content };
    }

    try {
      const result = await tool.execute(args, { signal: options.signal, agentName: this.name });
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result, isError: false });
      return { id: tc.id, content: result };
    } catch (err) {
      const content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      options.onEvent?.({ type: "tool_result", agent: this.name, tool: name, result: content, isError: true });
      return { id: tc.id, content };
    }
  }
}
