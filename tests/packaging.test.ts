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

test("installing from a clone builds dist, not just packing", () => {
  // dist/ is gitignored, so a clone has no entry point until something builds
  // it. `prepack` alone does NOT do that: it runs on pack/publish, while
  // `npm i ./use-conifer` and `npm i <git-url>` run `prepare`. Until the
  // registry release those two ARE how everyone installs this package, and
  // without `prepare` the install silently lands a directory with no
  // dist/src/index.js — MODULE_NOT_FOUND on first require, which is exactly
  // what the README and llms.txt tell people to do. Caught on 2026-08-26 by
  // following our own published instructions.
  assert.equal(pkg.scripts.prepare, "npm run build");
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

test("shipped declarations are real .d.ts a consumer can compile against", async () => {
  const dts = new URL("../dist/src/index.d.ts", import.meta.url);
  if (!existsSync(dts)) return;
  const text = readFileSync(dts, "utf8");
  // Re-exported types, not `any`: a .d.ts that erases the public shapes is
  // worse than none, because the consumer's editor confidently shows nothing.
  assert.match(text, /Completion/);
  assert.match(text, /Receipt/);
  assert.match(text, /ConiferPortabilityError/);

  // The lib requirement is DOCUMENTED at its source. `AsyncIterable` is
  // ES2018, so an ES2017 consumer sees TS2583 pointing into our types (the
  // official `openai` package fails the same check the same way). A reader
  // who hits it must find the explanation in the file the error names.
  const types = readFileSync(new URL("../dist/src/types.d.ts", import.meta.url), "utf8");
  assert.match(types, /lib\.es2018/i, "state the lib requirement where the error points");
  assert.match(types, /ES2018\+|"lib": \["ES2018"\]/, "say what to change");
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
  assert.equal(reply.result.tools.length, 5);
});

test("`npm test` runs on every Node the engines floor advertises", () => {
  // The suite imports `.ts` sources, so it used to be spelled
  // `node --experimental-strip-types --test tests/*.test.ts`. On the Node 20
  // that `engines` itself advertises, that is not a version error, it is
  // `node: bad option` — a message that names neither Node 22 nor this repo,
  // on a version the package claims to support. Found on 2026-08-27 by a
  // contributor doing exactly `npm ci && npm test`.
  //
  // The runner now picks a path per Node: strip types where that exists,
  // compile-then-run where it does not. This test pins the invariant that the
  // test script must not hard-code a flag that a supported Node rejects.
  assert.ok(
    !/--experimental-strip-types/.test(pkg.scripts.test),
    "the test script must not hard-code a flag Node 20 rejects with `bad option`",
  );

  const floor = Number(String(pkg.engines.node).replace(/[^\d.]/g, "").split(".")[0]);
  assert.ok(Number.isFinite(floor), "engines.node must name a major version");

  // The runner exists, and knows both routes.
  const runner = readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
  assert.match(runner, /experimental-strip-types/, "the fast path must still strip types");
  assert.match(runner, /tsc|typescript/i, "there must be a compile fallback for older Node");
});

test("the Python suite declares its test-only dependency somewhere a clone can find", () => {
  // `python -m pytest tests -q`, straight from CONTRIBUTING, met `No module
  // named pytest` in a fresh clone with no requirements file and no extra to
  // point at. A documented command that cannot work as written is a bug in the
  // docs or the packaging; this pins the packaging half.
  //
  // pytest must stay TEST-ONLY: `[project] dependencies` stays empty.
  const requirements = new URL("../python/requirements-dev.txt", import.meta.url);
  assert.ok(existsSync(requirements), "python/requirements-dev.txt must exist");
  assert.match(readFileSync(requirements, "utf8"), /pytest/);

  const pyproject = readFileSync(new URL("../python/pyproject.toml", import.meta.url), "utf8");
  assert.match(pyproject, /\[project\.optional-dependencies\]/, "declare a dev extra too");
  assert.match(pyproject, /dev = \[[^\]]*pytest/, "the dev extra is where pytest belongs");

  // The house rule, enforced rather than trusted: no runtime dependency.
  const runtime = /^dependencies = (\[\]|\[\s*\])$/m.test(pyproject);
  assert.ok(runtime, "the published package must still install with an empty dependency list");
});
