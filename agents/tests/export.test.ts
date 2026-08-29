import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportToMcp } from "../src/export/mcp.ts";
import { loadManifest } from "../src/plugins/manifest.ts";

const manifest = loadManifest({
  name: "github", version: "1.0.0",
  mcp: [{ name: "github", transport: "stdio", command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
        { name: "notion", transport: "http", url: "https://mcp.notion.example/${WORKSPACE}" }],
  hooks: { preToolCall: "./h.js#a" }, instructions: "frag",
});

test("exportToMcp emits standard mcpServers config, preserving placeholders", () => {
  const out = exportToMcp(manifest);
  assert.deepEqual(out.mcpServers.github,
    { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } });
  assert.deepEqual(out.mcpServers.notion, { url: "https://mcp.notion.example/${WORKSPACE}" });
});

test("hooks and instructions are skipped loudly, never dropped silently", () => {
  const out = exportToMcp(manifest);
  const fields = out.skipped.map((s) => s.field).sort();
  assert.deepEqual(fields, ["hooks", "instructions"]);
  assert.ok(out.skipped.every((s) => s.reason.length > 10));
});

test("CLI round-trip: file in, mcpServers JSON on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "conifer-agents-"));
  const file = join(dir, "m.json");
  writeFileSync(file, JSON.stringify({ name: "p", version: "1", mcp: [{ name: "s", transport: "stdio", command: "x" }] }));
  const stdout = execFileSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", "bin/conifer-agents.ts", "export", "--to", "mcp", file],
    { encoding: "utf8" });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.mcpServers.s, { command: "x" });
});

test("toolAllowlist cannot be expressed in mcpServers and is skipped loudly", () => {
  const out = exportToMcp(loadManifest({
    name: "p", version: "1",
    mcp: [{ name: "gh", transport: "stdio", command: "x", toolAllowlist: ["a", "b"] }],
  }));
  assert.deepEqual(out.mcpServers.gh, { command: "x" });
  const entry = out.skipped.find((s) => s.field === "mcp/gh/toolAllowlist");
  assert.ok(entry, "expected a skipped entry for the allowlist");
  assert.ok(entry.reason.length > 10);
});

test("dunder server names round-trip and still hit duplicate detection", () => {
  const out = exportToMcp(loadManifest({
    name: "p", version: "1",
    mcp: [{ name: "__proto__", transport: "stdio", command: "x" }],
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(out.mcpServers)), { ["__proto__"]: { command: "x" } });
  assert.throws(() => exportToMcp(loadManifest({
    name: "p", version: "1",
    mcp: [{ name: "__proto__", transport: "stdio", command: "x" },
          { name: "__proto__", transport: "stdio", command: "y" }],
  })), /duplicate MCP server name/);
});
