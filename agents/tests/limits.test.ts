import test from "node:test";
import assert from "node:assert/strict";
import { preflightTools, DEFAULT_TOOL_CAP } from "../src/limits.ts";
import { ToolLimitError, AgentError } from "../src/errors.ts";
import type { AgentTool } from "../src/types.ts";

function fakeTool(name: string, source?: string): AgentTool {
  return { name, description: "t", parameters: { type: "object" }, source,
           execute: async () => "ok" };
}

test("default cap is 128", () => assert.equal(DEFAULT_TOOL_CAP, 128));

test("over-cap throws ToolLimitError with per-source attribution", () => {
  const tools = [
    ...Array.from({ length: 92 }, (_, i) => fakeTool(`github__t${i}`, "plugin:github")),
    ...Array.from({ length: 44 }, (_, i) => fakeTool(`slack__t${i}`, "plugin:slack")),
    ...Array.from({ length: 6 }, (_, i) => fakeTool(`n${i}`)),
  ];
  assert.throws(() => preflightTools("orchestrator", tools, 128), (e: unknown) => {
    assert.ok(e instanceof ToolLimitError);
    assert.equal(e.count, 142);
    assert.match(e.message, /plugin:github: 92/);
    assert.match(e.message, /plugin:slack: 44/);
    assert.match(e.message, /native: 6/);
    return true;
  });
});

test("duplicate tool names are an error", () => {
  assert.throws(() => preflightTools("a", [fakeTool("x"), fakeTool("x")], 128),
    (e: unknown) => e instanceof AgentError && /duplicate tool name "x"/.test((e as Error).message));
});

test("at or under cap passes; >=80% returns a warning", () => {
  const under = Array.from({ length: 10 }, (_, i) => fakeTool(`t${i}`));
  assert.deepEqual(preflightTools("a", under, 128).warnings, []);
  const warm = Array.from({ length: 103 }, (_, i) => fakeTool(`t${i}`));
  assert.equal(preflightTools("a", warm, 128).warnings.length, 1);
});
