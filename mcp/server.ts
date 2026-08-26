// mcp/server.ts — Conifer as an MCP server.
//
// WHY THIS EXISTS. A one-line env drop-in only helps a tool that already speaks
// the OpenAI wire. An agent, a Slack bot, or an IDE that speaks MCP has no such
// hook: it can only use what its host exposes as a tool. This server is that
// hook — it puts the gateway (catalog, price-aware model choice, a completion,
// and the balance) into any MCP host as four tools.
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

/** The four tools. Each maps to one real gateway read or one real turn. */
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
      "Run one chat turn through the Conifer gateway and return the text PLUS the settled cost of that exact call in nanodollars ($1 = 1e9). Set max_cost_nanousd to refuse the turn before any upstream call if it could cost more than you want to spend.",
    inputSchema: {
      type: "object",
      required: ["model", "prompt"],
      properties: {
        model: { type: "string", description: "A catalog id; `vendor/model` spellings resolve too." },
        prompt: { type: "string" },
        system: { type: "string" },
        max_tokens: { type: "number" },
        temperature: { type: "number" },
        max_cost_nanousd: {
          type: "number",
          description: "HARD ceiling on this turn's worst-case cost. Over it, the gateway refuses before spending anything.",
        },
      },
    },
    async run(args, client) {
      const messages: Message[] = [];
      if (typeof args.system === "string") {
        messages.push({ role: "system", content: args.system });
      }
      messages.push({ role: "user", content: String(args.prompt ?? "") });
      const completion = await client.chat({
        model: String(args.model),
        messages,
        maxTokens: (args.max_tokens as number | undefined) ?? 1024,
        temperature: args.temperature as number | undefined,
        maxCostNanoUsd: args.max_cost_nanousd as number | undefined,
        client: "conifer-mcp",
      });
      return {
        text: completion.choices[0]?.message?.content ?? "",
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
    name: "conifer_balance",
    description:
      "Remaining spendable credit on the account behind this key, in nanodollars and as an exact USD string. A read; it never moves money.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, client) {
      return client.balance();
    },
  },
];

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
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) serve(process.stdin, process.stdout);
