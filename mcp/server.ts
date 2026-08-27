// mcp/server.ts — Conifer as an MCP server.
//
// WHY THIS EXISTS. A one-line env drop-in swaps the model BEHIND your coding
// agent. This server does something different: it puts the whole catalog IN
// FRONT of the agent, as tools it can call mid-task. The shape follows from
// how people actually use it inside a development pipeline:
//
//   · "Ask a second model" — your Cursor/Claude Code session is driven by one
//     model, but a task often wants another: a cheap one for a bulk rewrite, a
//     reasoning one for a design review. `conifer_complete` is that door, with
//     full multi-turn messages, not just a one-shot prompt.
//   · "Which model should this job use?" — `conifer_compare` runs the SAME
//     prompt across several models in parallel and returns each answer beside
//     its exact settled cost, so choosing a model for a pipeline step is an
//     experiment, not a vibe.
//   · "What can I even call, and what does it cost?" — `conifer_list_models`,
//     `conifer_choose_model`, `conifer_balance`.
//
// Every spending tool takes `max_cost_nanousd`. An agent that can see and bound
// what its calls cost can be told to spend less; one that cannot, cannot.
//
// WHY NO SDK DEPENDENCY. MCP over stdio is newline-delimited JSON-RPC 2.0. The
// whole protocol surface we need is initialize / tools/list / tools/call, so
// implementing it directly costs ~80 lines and buys a server that installs with
// no npm tree at all — which is the difference between "add this line to your
// config" and "set up a build first".
//
// WHY IT REPORTS COST. Every completion this server returns carries its own
// settled nanodollar receipt in the tool result. An agent that can see what its
// last call cost can be told to spend less; one that cannot, cannot.

import { Conifer } from "../src/index.ts";
import { ConiferError } from "../src/errors.ts";
import type { CatalogModel, Message } from "../src/types.ts";

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, client: Conifer): Promise<unknown>;
}

/** The six tools. Each maps to one real gateway read or one real turn. */
export const TOOLS: ToolDefinition[] = [
  {
    name: "conifer_list_models",
    description:
      "List the models this Conifer key can call, with declared capabilities, context windows, and the AS-CHARGED price for each entry's lane. Absent fields mean the catalog did not declare them, not that the model lacks the feature.",
    inputSchema: {
      type: "object",
      properties: {
        caps: {
          type: "array",
          items: { type: "string" },
          description: "Keep only models DECLARING all of these capabilities (e.g. tools, vision).",
        },
      },
    },
    async run(args, client) {
      const caps = (args.caps as string[] | undefined) ?? [];
      const models = await client.models();
      const filtered =
        caps.length === 0
          ? models
          : models.filter((model) => caps.every((cap) => model.caps?.includes(cap)));
      return filtered.map(summarize);
    },
  },
  {
    name: "conifer_choose_model",
    description:
      "Pick the cheapest catalog model that DECLARES the capabilities you need. This is a catalog read, not a second router: it ranks what the catalog states, skips models with undeclared capabilities rather than assuming them, and skips unpriced models rather than assuming they are free.",
    inputSchema: {
      type: "object",
      properties: {
        caps: { type: "array", items: { type: "string" } },
        min_context_window: { type: "number" },
      },
    },
    async run(args, client) {
      const chosen = await client.cheapestFor(
        (args.caps as string[] | undefined) ?? [],
        { minContextWindow: args.min_context_window as number | undefined },
      );
      if (chosen === undefined) {
        return {
          chosen: null,
          why: "no catalog entry declares every requested capability at a stated price. Relax the capabilities, or call conifer_list_models to see what is declared.",
        };
      }
      return { chosen: summarize(chosen) };
    },
  },
  {
    name: "conifer_complete",
    description:
      "Ask any model on the gateway one question — or hand it a whole conversation — and get the answer back with the exact settled cost of that call in nanodollars ($1 = 1e9). Use it mid-task to consult a different model than the one driving this session: a cheap one for bulk work, a reasoning one for a design question. Set max_cost_nanousd and the gateway refuses the call before spending anything if it could cost more.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: "A catalog id; `vendor/model` spellings resolve too." },
        prompt: { type: "string", description: "One-shot shortcut: becomes the single user message." },
        messages: {
          type: "array",
          description:
            "Full OpenAI-shaped conversation ({role, content}). Use this for multi-turn work — refining an answer, carrying context between calls. Wins over `prompt` when both are set.",
          items: { type: "object" },
        },
        system: { type: "string", description: "Prepended as the system message." },
        max_tokens: { type: "number" },
        temperature: { type: "number" },
        reasoning_effort: {
          type: "string",
          enum: ["none", "low", "medium", "high"],
          description: "Forwarded as the reasoning block. Only models that reason honor it.",
        },
        max_cost_nanousd: {
          type: "number",
          description: "HARD ceiling on this turn's worst-case cost. Over it, the gateway refuses before spending anything.",
        },
      },
    },
    async run(args, client) {
      const completion = await client.chat(
        completeRequest(args, { maxTokensDefault: 1024 }),
      );
      return {
        text: completion.choices[0]?.message?.content ?? "",
        // Vendor reasoning trace, when the model emitted one. Absent otherwise.
        reasoning:
          completion.choices[0]?.message?.reasoning ??
          completion.choices[0]?.message?.reasoning_content,
        model: completion.receipt.effectiveModel ?? completion.model,
        cost_nanousd: completion.receipt.costNanoUsd,
        cost_usd: completion.receipt.costUsd,
        cost_components_nanousd: completion.receipt.costComponentsNanoUsd,
        usage: completion.usage,
        request_id: completion.receipt.requestId,
      };
    },
  },
  {
    name: "conifer_compare",
    description:
      "Run the SAME prompt across several models in parallel and return each answer beside its exact settled cost, cheapest first. This is how you pick a model for a pipeline step with evidence instead of a guess: try the candidates on a real example from the job, read the answers, read the costs. A model that fails reports its error in place — one bad model never sinks the comparison. Each model's call is its own billed turn; max_cost_nanousd caps EACH turn, not the total.",
    inputSchema: {
      type: "object",
      required: ["models", "prompt"],
      properties: {
        models: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
          description: "2-5 catalog ids to try. Each is a separate billed call.",
        },
        prompt: { type: "string" },
        system: { type: "string" },
        max_tokens: { type: "number" },
        max_cost_nanousd: {
          type: "number",
          description: "Per-model ceiling. A model whose worst case exceeds it reports the refusal instead of an answer.",
        },
      },
    },
    async run(args, client) {
      const models = (args.models as string[] | undefined) ?? [];
      if (models.length < 2) {
        return { error: "give at least two models — comparing one model to itself is a completion, and conifer_complete does that cheaper." };
      }
      const settled = await Promise.all(
        models.slice(0, 5).map(async (model) => {
          try {
            const completion = await client.chat(
              completeRequest({ ...args, model, messages: undefined }, { maxTokensDefault: 1024 }),
            );
            const text = completion.choices[0]?.message?.content ?? "";
            return {
              model: completion.receipt.effectiveModel ?? model,
              text,
              // A reasoning model can spend the whole token budget thinking
              // and return empty text — a blank row reads as "broken" when
              // the honest reading is "give it more max_tokens". Say so.
              ...(text === "" && {
                note: "empty answer: the model spent its max_tokens on reasoning; raise max_tokens or set reasoning_effort on conifer_complete",
              }),
              cost_nanousd: completion.receipt.costNanoUsd,
              cost_usd: completion.receipt.costUsd,
              usage: completion.usage,
            };
          } catch (error) {
            const failure = error instanceof ConiferError ? error : undefined;
            return {
              model,
              error: failure ? `${failure.type}: ${failure.message}` : String(error),
            };
          }
        }),
      );
      // Cheapest first; failures sink to the bottom where they read as footnotes.
      settled.sort((a, b) => {
        const costA = "cost_nanousd" in a && a.cost_nanousd !== undefined ? a.cost_nanousd : Number.MAX_SAFE_INTEGER;
        const costB = "cost_nanousd" in b && b.cost_nanousd !== undefined ? b.cost_nanousd : Number.MAX_SAFE_INTEGER;
        return costA - costB;
      });
      return { results: settled };
    },
  },
  {
    name: "conifer_embed",
    description:
      "Turn text into embedding vectors, with the exact settled cost of that call. Send one string or a batch; you get one vector per input, in the order you sent them. Use it to build or query a semantic index mid-task, or to rank candidates by cosine similarity (this gateway serves no rerank door, and embeddings are the honest substitute). Only models whose caps include \"embeddings\" answer here — call conifer_choose_model with caps:[\"embeddings\"] to pick the cheapest one.",
    inputSchema: {
      type: "object",
      required: ["model", "input"],
      properties: {
        model: {
          type: "string",
          description: 'A model DECLARING caps:["embeddings"]. A chat model is refused, naming the chat door.',
        },
        input: {
          description: "A string, or an array of strings for a batch.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        dimensions: {
          type: "number",
          description: "Matryoshka shortening, on models that support it.",
        },
        max_cost_nanousd: {
          type: "number",
          description: "Refuse the call before spending if it could cost more than this.",
        },
      },
    },
    async run(args, client) {
      const result = await client.embeddings.create({
        model: String(args.model),
        input: args.input as string | string[],
        dimensions: args.dimensions as number | undefined,
        maxCostNanoUsd: args.max_cost_nanousd as number | undefined,
        client: "conifer-mcp",
      });
      // The vectors themselves are deliberately NOT returned in full: a single
      // 1536-dimension embedding is ~30 KB of digits, and a batch would blow
      // any agent's context window for numbers no model can read anyway. The
      // caller gets the shape, the cost, and a short preview to confirm the
      // call worked; a program that needs the values should use the SDK.
      return {
        model: result.model,
        count: result.data.length,
        dimensions: result.data[0]?.embedding.length,
        preview: result.data[0]?.embedding.slice(0, 4),
        prompt_tokens: result.usage?.prompt_tokens,
        cost_nanousd: result.receipt.costNanoUsd,
        cost_usd: result.receipt.costUsd,
        request_id: result.receipt.requestId,
      };
    },
  },
  {
    name: "conifer_balance",
    description:
      "Remaining spendable credit on the account behind this key, in nanodollars and as an exact USD string. A read; it never moves money.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, client) {
      return client.balance();
    },
  },
];

/**
 * The shared complete/compare request builder. One construction site so the
 * two spending tools cannot drift: same message assembly, same ceiling, same
 * attribution tag.
 */
export function completeRequest(
  args: Record<string, unknown>,
  defaults: { maxTokensDefault: number },
): Parameters<Conifer["chat"]>[0] {
  const messages: Message[] = [];
  if (typeof args.system === "string") {
    messages.push({ role: "system", content: args.system });
  }
  if (Array.isArray(args.messages) && args.messages.length > 0) {
    messages.push(...(args.messages as Message[]));
  } else {
    messages.push({ role: "user", content: String(args.prompt ?? "") });
  }
  const effort = args.reasoning_effort;
  return {
    model: String(args.model),
    messages,
    maxTokens: (args.max_tokens as number | undefined) ?? defaults.maxTokensDefault,
    temperature: args.temperature as number | undefined,
    reasoning:
      typeof effort === "string" && ["none", "low", "medium", "high"].includes(effort)
        ? { effort: effort as "none" | "low" | "medium" | "high" }
        : undefined,
    maxCostNanoUsd: args.max_cost_nanousd as number | undefined,
    client: "conifer-mcp",
  };
}

function summarize(model: CatalogModel) {
  return {
    id: model.id,
    provider: model.provider,
    lane: model.endpointKind,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    caps: model.caps,
    pricing: model.pricing,
    fee_pct: model.feePct,
    unavailable: model.unavailable,
  };
}

/**
 * Handle one JSON-RPC message. Pure: takes a request and a client, returns the
 * response object (or `undefined` for a notification). Exported so the tests
 * drive the real protocol rather than a paraphrase of it.
 */
export async function handle(
  request: JsonRpcRequest,
  client: () => Conifer,
): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: request.id ?? null, result });

  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "conifer", version: "0.1.0" },
      });
    case "notifications/initialized":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = request.params?.name as string;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32602, message: `no such tool: ${name}` },
        };
      }
      const args = (request.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await tool.run(args, client());
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // A gateway refusal is DATA for the agent, not a transport fault: it
        // carries the remedy (add credits, lower the ceiling, pick another
        // model), and an agent that sees it can act on it.
        const message =
          error instanceof ConiferError
            ? `${error.type}: ${error.message}`
            : `unexpected error: ${String(error)}`;
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32601, message: `method not found: ${request.method}` },
      };
  }
}

/** stdio transport: newline-delimited JSON-RPC in, the same out. */
export function serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  // Constructed lazily so `--help`-style probes and tools/list work even before
  // a key is present; only a tool that actually calls the gateway needs one.
  let cached: Conifer | undefined;
  const client = () => (cached ??= new Conifer());

  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      void (async () => {
        let response: Record<string, unknown> | undefined;
        try {
          response = await handle(JSON.parse(line) as JsonRpcRequest, client);
        } catch (error) {
          response = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `parse error: ${String(error)}` },
          };
        }
        if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
      })();
    }
  });
}

// Run as a binary, stay importable as a module.
//
// The obvious guard — comparing `import.meta.url` to `process.argv[1]` — is
// WRONG for a published package, and silently so: `npx conifer-mcp` runs the
// bin shim, so argv[1] is the shim's path and never this module's. The server
// then started nothing and exited 0, which looks exactly like an MCP host
// getting no answer. Measured against a real `npm i` consumer on Node 22.
//
// So the shim asks explicitly (`bin/conifer-mcp.mjs` sets the flag by importing
// this module for its side effect), and a direct `node mcp/server.ts` still
// works via the argv comparison for the development path.
function shouldServe(): boolean {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // Direct execution: `node mcp/server.ts` (or the compiled dist path).
  const here = import.meta.url.replace(/\.ts$/, "");
  const invoked = new URL(`file://${entry}`).href.replace(/\.(ts|js)$/, "");
  if (here.replace(/\.js$/, "") === invoked) return true;
  // Published binary: the bin shim is the entry point.
  return /conifer-mcp(\.mjs)?$/.test(entry);
}

if (shouldServe()) serve(process.stdin, process.stdout);
