import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
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
