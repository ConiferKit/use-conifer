// live.test.ts — measured, never asserted beyond "a real answer came back"
// (fusion-acceptance ethos). The gateway test is gated on CONIFER_API_KEY;
// the MCP test is local-only (npx spawns the reference server) and skips
// itself with a console note if npx/network is unavailable.

import test from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "../src/orchestrate.ts";
import { McpPluginRuntime } from "../src/plugins/mcp.ts";

const KEY = process.env.CONIFER_API_KEY;

test("live: two-agent tree answers and settles a cost", { skip: !KEY }, async () => {
  const team = orchestrate({
    orchestrator: {
      model: "claude-haiku-4-5",
      instructions: "You have a `researcher` subagent. Delegate the question to it, then answer in one sentence based on its reply.",
    },
    subagents: {
      researcher: { model: "claude-haiku-4-5", instructions: "Answer factual questions in one sentence." },
    },
    maxCostNanoUsd: 50_000_000,
  });
  const run = await team.run("What is a Hohmann transfer?");
  assert.ok(run.output.length > 0, "empty answer");
  assert.ok(run.receipt.totalCostNanoUsd > 0, "no settled cost");
  assert.ok(run.receipt.calls.length >= 2, "expected orchestrator + subagent calls");
  console.log(`live tree: ${run.receipt.calls.length} calls, ${run.receipt.totalCostNanoUsd} nanoUSD, ${run.turns} turns`);
});

test("live: real MCP stdio server lists tools and echoes", async (t) => {
  const rt = new McpPluginRuntime("everything", [{
    name: "everything",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  }]);
  let tools;
  try {
    tools = await rt.tools();
  } catch (e) {
    // npx/network unavailable in this environment; do not fail the suite.
    console.log(`live mcp: skipped, could not spawn reference server: ${String(e)}`);
    await rt.shutdown();
    t.skip("npx/network unavailable");
    return;
  }
  try {
    assert.ok(tools.length > 0, "server listed no tools");
    const echo = tools.find((tool) => tool.name === "everything__echo");
    assert.ok(echo, "reference server did not expose echo");
    const out = await echo.execute({ message: "conifer-agents live" }, { agentName: "live" });
    assert.match(out, /conifer-agents live/);
    console.log(`live mcp: ${tools.length} tools, echo -> ${JSON.stringify(out)}`);
  } finally {
    await rt.shutdown();
  }
});
