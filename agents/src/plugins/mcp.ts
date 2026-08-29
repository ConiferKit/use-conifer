// plugins/mcp.ts — MCP plugin runtime: lazy shared connections, tool
// prefixing, allowlists, plugin attribution.
//
// The real MCP client is loaded with dynamic import() inside the default
// connector, so consumers (and unit tests) that never touch MCP never load
// @modelcontextprotocol/sdk.

import { McpConnectionError } from "../errors.ts";
import type { AgentTool } from "../types.ts";
import type { McpServerSpec } from "./manifest.ts";

/** Seam for tests; the real implementation wraps @modelcontextprotocol/sdk Client. */
export interface McpClientLike {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] }>;
  callTool(o: { name: string; arguments: Record<string, unknown> }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

/** Default connector: builds a real @modelcontextprotocol/sdk client. */
async function realConnect(spec: McpServerSpec): Promise<McpClientLike> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "conifer-agents", version: "0.1.0" });
  if (spec.transport === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    await client.connect(new StdioClientTransport({
      command: spec.command ?? "",
      args: spec.args,
      env: spec.env,
    }));
  } else {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url ?? ""), {
      requestInit: spec.headers ? { headers: spec.headers } : undefined,
    }));
  }
  return client as unknown as McpClientLike;
}

/** Flatten a tool result: concatenate text content; error results return their text as-is. */
function renderResult(r: { content: { type: string; text?: string }[]; isError?: boolean }): string {
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

export class McpPluginRuntime {
  readonly #pluginName: string;
  readonly #specs: McpServerSpec[];
  readonly #connect: (spec: McpServerSpec) => Promise<McpClientLike>;
  /** Memoized connections, one per server. Cleared by shutdown(). */
  readonly #clients = new Map<string, Promise<McpClientLike>>();

  constructor(
    pluginName: string,
    specs: McpServerSpec[],
    connect: (spec: McpServerSpec) => Promise<McpClientLike> = realConnect,
  ) {
    this.#pluginName = pluginName;
    this.#specs = specs;
    this.#connect = connect;
  }

  #client(spec: McpServerSpec): Promise<McpClientLike> {
    let existing = this.#clients.get(spec.name);
    if (!existing) {
      existing = this.#connect(spec).catch((cause: unknown) => {
        this.#clients.delete(spec.name); // allow retry after a failed connect
        throw new McpConnectionError({ server: spec.name, transport: spec.transport, cause });
      });
      this.#clients.set(spec.name, existing);
    }
    return existing;
  }

  /**
   * Lazy: connects on first call, one connection per server across calls.
   * Prefixes names `<server>__<tool>`, applies toolAllowlist (on unprefixed
   * names), sets source `plugin:<pluginName>`.
   */
  async tools(): Promise<AgentTool[]> {
    const out: AgentTool[] = [];
    for (const spec of this.#specs) {
      const client = await this.#client(spec);
      const { tools } = await client.listTools();
      const allow = spec.toolAllowlist ? new Set(spec.toolAllowlist) : null;
      for (const t of tools) {
        if (allow && !allow.has(t.name)) continue;
        const wireName = t.name; // unprefixed name goes over the wire
        out.push({
          name: `${spec.name}__${t.name}`,
          description: t.description ?? "",
          parameters: t.inputSchema,
          source: `plugin:${this.#pluginName}`,
          execute: async (args) => {
            const c = await this.#client(spec);
            return renderResult(await c.callTool({ name: wireName, arguments: args }));
          },
        });
      }
    }
    return out;
  }

  /** Closes all connected clients. Safe to call twice. */
  async shutdown(): Promise<void> {
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(pending.map(async (p) => {
      const client = await p.catch(() => null); // failed connects have nothing to close
      await client?.close();
    }));
  }
}
