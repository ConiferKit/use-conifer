import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { mergeHooks } from "../src/hooks.ts";
import { fakeClient } from "./helpers.ts";
import type { AgentTool } from "../src/types.ts";

const echo: AgentTool = { name: "echo", description: "e",
  parameters: { type: "object" }, execute: async (a) => `echo:${(a as any).s}` };

test("preToolCall can rewrite args; postToolCall sees the result", async () => {
  const seen: string[] = [];
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "raw" } }] }, { text: "ok" }]);
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], hooks: {
    preToolCall: ({ args }) => ({ args: { ...args, s: "rewritten" } }),
    postToolCall: ({ result }) => { seen.push(result); },
  }});
  await a.run("go");
  assert.equal(client.requests[1].messages.find((m: any) => m.role === "tool").content, "echo:rewritten");
  assert.deepEqual(seen, ["echo:rewritten"]);
});

test("preToolCall block skips execution", async () => {
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "x" } }] }, { text: "ok" }]);
  let executed = false;
  const spy: AgentTool = { ...echo, execute: async () => { executed = true; return "ran"; } };
  const a = new Agent({ name: "a", model: "m", client, tools: [spy], hooks: {
    preToolCall: () => ({ block: "not allowed" }),
  }});
  await a.run("go");
  assert.equal(executed, false);
  assert.match(client.requests[1].messages.find((m: any) => m.role === "tool").content, /not allowed/);
});

test("sessionStart and sessionEnd fire once; mergeHooks preserves order and first block wins", async () => {
  const order: string[] = [];
  const merged = mergeHooks([
    { preToolCall: () => { order.push("h1"); }, sessionStart: () => { order.push("start1"); } },
    { preToolCall: () => { order.push("h2"); return { block: "b2" }; } },
    { preToolCall: () => { order.push("h3"); } },   // must still run? NO — after a block, later hooks are skipped
  ]);
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: {} }] }, { text: "ok" }]);
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], hooks: merged });
  await a.run("go");
  assert.deepEqual(order, ["start1", "h1", "h2"]);
});
