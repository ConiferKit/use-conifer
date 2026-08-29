import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { BudgetExceededError } from "../src/errors.ts";
import { fakeClient } from "./helpers.ts";
import type { RunEvent } from "../src/types.ts";

test("subagent runs as a tool and its cost folds into the parent receipt", async () => {
  const childClient = fakeClient([{ text: "child answer", costNanoUsd: 3_000_000 }]);
  const child = new Agent({ name: "researcher", model: "m1", client: childClient,
    instructions: "You research." });
  const parentClient = fakeClient([
    { toolCalls: [{ name: "researcher", args: { task: "find X" } }], costNanoUsd: 2_000_000 },
    { text: "parent answer", costNanoUsd: 2_000_000 },
  ]);
  const events: RunEvent[] = [];
  const parent = new Agent({ name: "boss", model: "m2", client: parentClient,
    tools: [child.asTool()] });
  const run = await parent.run("go", { onEvent: (e) => events.push(e) });
  assert.equal(run.output, "parent answer");
  assert.equal(run.receipt.totalCostNanoUsd, 7_000_000);   // 2 + 3 + 2
  assert.equal(run.receipt.calls.length, 3);
  assert.ok(run.receipt.calls.some((c) => c.agent === "researcher"));
  assert.ok(events.some((e) => e.type === "subagent_start"));
  const end = events.find((e) => e.type === "subagent_end");
  assert.equal((end as any).costNanoUsd, 3_000_000);
  // the child's answer was fed to the parent as the tool result
  const toolMsg = parentClient.requests[1].messages.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.content, "child answer");
});

test("asTool marks source as subagent and derives description", () => {
  const child = new Agent({ name: "writer", model: "m", client: fakeClient([{ text: "x" }]),
    instructions: "You write reports." });
  const tool = child.asTool();
  assert.equal(tool.name, "writer");
  assert.equal(tool.source, "subagent");
  assert.match(tool.description, /writer/);
  assert.match(tool.description, /You write reports\./);
});

test("tree budget propagates into the child's gateway calls and a child overrun throws", async () => {
  // Parent budget 5M; the parent's first call spends 2M, so the child's
  // request must carry a ceiling of at most 3M.
  const childEcho = {
    name: "echo", description: "e", parameters: { type: "object" },
    execute: async () => "ok",
  };
  const childClient = fakeClient([
    { toolCalls: [{ name: "echo", args: {} }], costNanoUsd: 4_000_000 },  // overruns the cap
    { text: "never reached" },
  ]);
  const child = new Agent({ name: "spender", model: "m1", client: childClient,
    tools: [childEcho] });   // no maxCostNanoUsd of its own
  const parentClient = fakeClient([
    { toolCalls: [{ name: "spender", args: { task: "burn" } }], costNanoUsd: 2_000_000 },
    { text: "parent answer" },
  ]);
  const parent = new Agent({ name: "boss", model: "m2", client: parentClient,
    tools: [child.asTool()], maxCostNanoUsd: 5_000_000 });

  await assert.rejects(parent.run("go"), (e: unknown) => {
    assert.ok(e instanceof BudgetExceededError);
    assert.equal(e.budgetNanoUsd, 3_000_000);           // the tightened child cap
    assert.equal(e.receipt.totalCostNanoUsd, 4_000_000); // the child's settled spend
    return true;
  });
  // The child's request carried the parent's remaining headroom as a hard ceiling.
  assert.equal(childClient.requests.length, 1);
  assert.ok(childClient.requests[0].maxCostNanoUsd <= 3_000_000);
  assert.equal(childClient.requests[0].maxCostNanoUsd, 3_000_000);
});

test("child's own tighter budget wins over the tree headroom", async () => {
  const childClient = fakeClient([{ text: "cheap", costNanoUsd: 500_000 }]);
  const child = new Agent({ name: "frugal", model: "m1", client: childClient,
    maxCostNanoUsd: 1_000_000 });
  const parentClient = fakeClient([
    { toolCalls: [{ name: "frugal", args: { task: "t" } }], costNanoUsd: 2_000_000 },
    { text: "done", costNanoUsd: 1_000_000 },
  ]);
  const parent = new Agent({ name: "boss", model: "m2", client: parentClient,
    tools: [child.asTool()], maxCostNanoUsd: 10_000_000 });
  const run = await parent.run("go");
  assert.equal(run.output, "done");
  // min(child's own 1M, tree headroom 8M) = 1M
  assert.equal(childClient.requests[0].maxCostNanoUsd, 1_000_000);
});
