import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadManifest, resolveEnv, definePlugin } from "../src/plugins/manifest.ts";
import { PluginValidationError } from "../src/errors.ts";

const good = {
  name: "github", version: "1.0.0",
  mcp: [{ name: "github", transport: "stdio", command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
          toolAllowlist: ["create_issue"] }],
  instructions: "Use GitHub tools.",
};

test("schema file exists and requires name+version", () => {
  const schema = JSON.parse(readFileSync(new URL("../../contracts/plugin-manifest.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.required.sort(), ["name", "version"]);
});

test("valid manifest loads", () => {
  const m = loadManifest(good);
  assert.equal(m.mcp?.[0]?.toolAllowlist?.[0], "create_issue");
});

test("invalid manifests throw PluginValidationError with paths", () => {
  assert.throws(() => loadManifest({ version: "1.0.0" }),
    (e: unknown) => e instanceof PluginValidationError && e.problems.some((p) => p.includes("/name")));
  assert.throws(() => loadManifest({ name: "x", version: "1", mcp: [{ name: "s", transport: "stdio" }] }),
    (e: unknown) => e instanceof PluginValidationError && e.problems.some((p) => p.includes("command")));
  assert.throws(() => loadManifest({ name: "Bad Name", version: "1" }),
    (e: unknown) => e instanceof PluginValidationError);
});

test("resolveEnv interpolates and fails loudly on missing vars", () => {
  const spec = loadManifest(good).mcp![0]!;
  const ok = resolveEnv(spec, { GITHUB_TOKEN: "tok_123" });
  assert.equal(ok.env!.GITHUB_TOKEN, "tok_123");
  assert.throws(() => resolveEnv(spec, {}),
    (e: unknown) => e instanceof PluginValidationError && /GITHUB_TOKEN/.test((e as Error).message));
});

test("definePlugin validates and carries code hooks", () => {
  const p = definePlugin(good, { preToolCall: () => undefined });
  assert.equal(p.manifest.name, "github");
  assert.ok(p.hooks?.preToolCall);
});
