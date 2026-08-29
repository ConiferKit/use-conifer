import test from "node:test";
import assert from "node:assert/strict";
import { McpPluginRuntime } from "../src/plugins/mcp.ts";
import { McpConnectionError } from "../src/errors.ts";
import type { McpClientLike } from "../src/plugins/mcp.ts";

function fakeMcp(tools: string[], onCall?: (name: string) => string): McpClientLike {
  return {
    async listTools() {
      return { tools: tools.map((name) => ({ name, description: `d:${name}`, inputSchema: { type: "object" } })) };
    },
    async callTool({ name }) { return { content: [{ type: "text", text: onCall?.(name) ?? `ran:${name}` }] }; },
    async close() {},
  };
}

test("tools are prefixed, allowlisted, and attributed to the plugin", async () => {
  const rt = new McpPluginRuntime("github",
    [{ name: "github", transport: "stdio", command: "x", toolAllowlist: ["create_issue"] }],
    async () => fakeMcp(["create_issue", "delete_repo"]));
  const tools = await rt.tools();
  assert.deepEqual(tools.map((t) => t.name), ["github__create_issue"]);
  assert.equal(tools[0]!.source, "plugin:github");
  const out = await tools[0]!.execute({}, { agentName: "a" });
  assert.equal(out, "ran:create_issue");   // unprefixed name goes over the wire
});

test("connect is lazy and shared: zero connects before tools(), one per server after two calls", async () => {
  let connects = 0;
  const rt = new McpPluginRuntime("p", [{ name: "s", transport: "stdio", command: "x" }],
    async () => { connects++; return fakeMcp(["t"]); });
  assert.equal(connects, 0);
  await rt.tools(); await rt.tools();
  assert.equal(connects, 1);
});

test("connection failure wraps in McpConnectionError naming server and transport", async () => {
  const rt = new McpPluginRuntime("p", [{ name: "broken", transport: "http", url: "http://x" }],
    async () => { throw new Error("ECONNREFUSED"); });
  await assert.rejects(rt.tools(), (e: unknown) => {
    assert.ok(e instanceof McpConnectionError);
    assert.match((e as Error).message, /broken/);
    assert.match((e as Error).message, /http/);
    return true;
  });
});

test("shutdown closes clients and is idempotent", async () => {
  let closed = 0;
  const client = { ...fakeMcp(["t"]), close: async () => { closed++; } };
  const rt = new McpPluginRuntime("p", [{ name: "s", transport: "stdio", command: "x" }], async () => client);
  await rt.tools();
  await rt.shutdown(); await rt.shutdown();
  assert.equal(closed, 1);
});
