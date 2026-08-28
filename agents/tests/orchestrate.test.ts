import test from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "../src/orchestrate.ts";
import { definePlugin } from "../src/plugins/manifest.ts";
import { fakeClient } from "./helpers.ts";

// A plugin with no MCP servers but hooks + instructions exercises mounting
// without network. MCP-bearing orchestration is Task 10's live test.
const audit = definePlugin({ name: "audit", version: "1.0.0", instructions: "Log everything." },
  { preToolCall: () => undefined });

test("subagents mount as orchestrator tools; sub answer reaches the orchestrator", async () => {
  const client = fakeClient([
    { toolCalls: [{ name: "researcher", args: { task: "find" } }], costNanoUsd: 1_000_000 },
    { text: "final", costNanoUsd: 1_000_000 },
  ]);
  const subClient = fakeClient([{ text: "sub answer", costNanoUsd: 2_000_000 }]);
  const team = orchestrate({
    orchestrator: { model: "m-big", instructions: "Delegate." },
    subagents: { researcher: { model: "m-small", instructions: "Research things." } },
    client,
  });
  team.subagents.researcher!.client = subClient as any;   // Agent.client is settable for tests
  const run = await team.run("go");
  assert.equal(run.output, "final");
  assert.equal(run.receipt.totalCostNanoUsd, 4_000_000);
  // orchestrator's first request carried exactly one tool: the subagent handle
  assert.deepEqual(client.requests[0].tools.map((t: any) => t.function.name), ["researcher"]);
});

test("plugins mount only where referenced; instructions fragment appends", async () => {
  const client = fakeClient([{ text: "done" }]);
  const subClient = fakeClient([{ text: "sub" }]);
  const team = orchestrate({
    orchestrator: { model: "m", instructions: "Boss." },
    subagents: { helper: { model: "m", instructions: "Help.", plugins: { audit: true } } },
    plugins: [audit], client,
  });
  team.subagents.helper!.client = subClient as any;
  await team.run("go");
  assert.equal(team.subagents.helper!.instructions, "Help.\n\nLog everything.");
  assert.equal(team.orchestrator.instructions, "Boss.");   // not mounted there
});

test("unknown plugin reference fails at build time", () => {
  assert.throws(() => orchestrate({
    orchestrator: { model: "m", instructions: "x" },
    subagents: { a: { model: "m", instructions: "y", plugins: { ghost: true } } },
    client: fakeClient([{ text: "x" }]),
  }), /ghost/);
});

test("top-level budget lands on the orchestrator", () => {
  const team = orchestrate({
    orchestrator: { model: "m", instructions: "x" },
    subagents: {}, maxCostNanoUsd: 9_000_000, client: fakeClient([{ text: "x" }]),
  });
  assert.equal(team.orchestrator.maxCostNanoUsd, 9_000_000);
});
