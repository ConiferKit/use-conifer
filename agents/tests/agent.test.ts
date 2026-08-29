import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { BudgetExceededError, MaxTurnsError } from "../src/errors.ts";
import { fakeClient } from "./helpers.ts";
import type { AgentTool, RunEvent } from "../src/types.ts";

const echo: AgentTool = {
  name: "echo", description: "echoes", parameters: { type: "object", properties: { s: { type: "string" } } },
  execute: async (args) => `echo:${(args as any).s}`,
};

test("plain text answer returns output and receipt", async () => {
  const client = fakeClient([{ text: "hello", costNanoUsd: 2_000_000 }]);
  const a = new Agent({ name: "a", model: "m", client });
  const run = await a.run("hi");
  assert.equal(run.output, "hello");
  assert.equal(run.receipt.totalCostNanoUsd, 2_000_000);
  assert.equal(run.turns, 1);
});

test("tool call is dispatched and its result fed back", async () => {
  const client = fakeClient([
    { toolCalls: [{ name: "echo", args: { s: "abc" } }] },
    { text: "done" },
  ]);
  const events: RunEvent[] = [];
  const a = new Agent({ name: "a", model: "m", client, tools: [echo] });
  const run = await a.run("go", { onEvent: (e) => events.push(e) });
  assert.equal(run.output, "done");
  // the second request carries the tool result message
  const second = client.requests[1];
  const toolMsg = second.messages.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.content, "echo:abc");
  assert.ok(events.some((e) => e.type === "tool_result"));
});

test("budget: remaining maxCostNanoUsd is passed down and exhaustion throws", async () => {
  const client = fakeClient([
    { toolCalls: [{ name: "echo", args: { s: "x" } }], costNanoUsd: 4_000_000 },
    { toolCalls: [{ name: "echo", args: { s: "y" } }], costNanoUsd: 4_000_000 },
    { text: "never" },
  ]);
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], maxCostNanoUsd: 5_000_000 });
  await assert.rejects(a.run("go"), (e: unknown) => {
    assert.ok(e instanceof BudgetExceededError);
    assert.equal(e.receipt.totalCostNanoUsd, 4_000_000);
    return true;
  });
  assert.equal(client.requests[0].maxCostNanoUsd, 5_000_000);
});

test("maxTurns throws MaxTurnsError with receipt", async () => {
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "x" } }] }]);
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], maxTurns: 3 });
  await assert.rejects(a.run("go"), (e: unknown) => e instanceof MaxTurnsError);
});

test("tool execute throwing becomes an error result, not a crash", async () => {
  const boom: AgentTool = { name: "boom", description: "b", parameters: { type: "object" },
    execute: async () => { throw new Error("kapow"); } };
  const client = fakeClient([{ toolCalls: [{ name: "boom", args: {} }] }, { text: "recovered" }]);
  const a = new Agent({ name: "a", model: "m", client, tools: [boom] });
  const run = await a.run("go");
  assert.equal(run.output, "recovered");
  const toolMsg = client.requests[1].messages.find((m: any) => m.role === "tool");
  assert.match(toolMsg.content, /kapow/);
});

test("abort signal stops before the next turn", async () => {
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "x" } }] }]);
  const ctrl = new AbortController();
  const slow: AgentTool = { ...echo, execute: async () => { ctrl.abort(); return "late"; } };
  const a = new Agent({ name: "a", model: "m", client, tools: [slow] });
  await assert.rejects(a.run("go", { signal: ctrl.signal }), /abort/i);
});

test("run_end and sessionEnd fire on MaxTurnsError with turns and cost so far", async () => {
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "x" } }], costNanoUsd: 1_000_000 }]);
  const events: RunEvent[] = [];
  let ended: { turns: number; cost: number; output: string } | undefined;
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], maxTurns: 3, hooks: {
    sessionEnd: ({ result }) => {
      ended = { turns: result.turns, cost: result.receipt.totalCostNanoUsd, output: result.output };
      throw new Error("hook boom");   // must NOT mask MaxTurnsError
    },
  }});
  await assert.rejects(a.run("go", { onEvent: (e) => events.push(e) }),
    (e: unknown) => e instanceof MaxTurnsError);
  const end = events.find((e) => e.type === "run_end") as any;
  assert.ok(end, "run_end must fire on MaxTurnsError");
  assert.equal(end.turns, 3);
  assert.equal(end.costNanoUsd, 3_000_000);
  assert.deepEqual(ended, { turns: 3, cost: 3_000_000, output: "" });
});

test("run_end fires on BudgetExceededError too", async () => {
  const client = fakeClient([{ toolCalls: [{ name: "echo", args: { s: "x" } }], costNanoUsd: 4_000_000 }]);
  const events: RunEvent[] = [];
  const a = new Agent({ name: "a", model: "m", client, tools: [echo], maxCostNanoUsd: 5_000_000 });
  await assert.rejects(a.run("go", { onEvent: (e) => events.push(e) }),
    (e: unknown) => e instanceof BudgetExceededError);
  const end = events.find((e) => e.type === "run_end") as any;
  assert.ok(end, "run_end must fire on BudgetExceededError");
  assert.equal(end.costNanoUsd, 4_000_000);
});
