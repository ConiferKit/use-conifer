// tests/packaging.test.ts — the package as a CONSUMER receives it.
//
// Every other suite imports `src/*.ts` directly, which is exactly the blind
// spot that shipped two defects: an `engines` floor of ">=22" that Node 22
// could not actually run (the entry point was a raw .ts file), and an MCP bin
// that exited 0 in silence because its direct-invocation guard compared
// against argv[1], which is the shim, not the module. Both were invisible from
// inside the repo and obvious from one `npm i`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Resolve an exports entry to a path on disk. */
function target(entry: unknown): string {
  const value =
    typeof entry === "string" ? entry : (entry as { default?: string })?.default ?? "";
  return new URL(value, new URL("../", import.meta.url)).pathname;
}

test("published entry points are compiled JS, not raw TypeScript", () => {
  // A .ts entry point is ERR_UNKNOWN_FILE_EXTENSION on any Node without
  // type-stripping on by default. "Works on my Node" is not a distribution.
  for (const [name, entry] of Object.entries(pkg.exports)) {
    const path = target(entry);
    assert.ok(path.endsWith(".js"), `${name} must resolve to .js, got ${path}`);
  }
  assert.ok(pkg.types.endsWith(".d.ts"), "consumers need type declarations");
});

test("the engines floor is honest about what it can run", () => {
  // The floor may only claim a version that can execute the shipped entry
  // point. Compiled ESM is fine from 18; raw .ts would not be.
  assert.equal(pkg.engines.node, ">=18");
});

test("everything package.json points at is inside `files`", () => {
  const shipped: string[] = pkg.files;
  const referenced = [
    ...Object.values(pkg.exports).map(target),
    target(pkg.types),
    target(pkg.bin["conifer-mcp"]),
  ];
  for (const path of referenced) {
    const relative = path.slice(root.length);
    assert.ok(
      shipped.some((dir) => relative.startsWith(dir)),
      `${relative} is referenced but not in files: ${shipped.join(", ")}`,
    );
  }
});

test("a built dist exists and exposes the public seam", async () => {
  const index = new URL("../dist/src/index.js", import.meta.url);
  if (!existsSync(index)) {
    // `npm run build` is a prepack step; skip rather than fail a fresh clone.
    return;
  }
  const mod = (await import(index.href)) as Record<string, unknown>;
  for (const name of ["Conifer", "fromOpenRouter", "readReceipt", "ConiferPortabilityError"]) {
    assert.equal(typeof mod[name], "function", `dist must export ${name}`);
  }
});

test("the MCP bin answers over stdio instead of exiting silently", () => {
  const bin = new URL("../bin/conifer-mcp.mjs", import.meta.url);
  if (!existsSync(new URL("../dist/mcp/server.js", import.meta.url))) return;
  const out = execFileSync(process.execPath, [fileURLToPath(bin)], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    encoding: "utf8",
    // tools/list must not need a credential: a host inspects before it calls.
    env: { ...process.env, CONIFER_API_KEY: "" },
  });
  assert.notEqual(out.trim(), "", "the bin produced no output at all");
  const reply = JSON.parse(out.trim().split("\n")[0] as string);
  assert.equal(reply.result.tools.length, 4);
});
