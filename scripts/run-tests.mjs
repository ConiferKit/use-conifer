#!/usr/bin/env node
// `npm test` on every Node the package claims to support.
//
// The suite imports the `.ts` sources directly, which used to mean the test
// script was literally unrunnable below Node 22.6: `node
// --experimental-strip-types` exits with `node: bad option`, a message that
// names neither this repo nor a version. A contributor on the Node 20 that our
// own `engines` floor advertises had no way to tell a missing feature from a
// broken checkout.
//
// So: on a Node that can strip types, run the sources directly (fast path, no
// build step, unchanged behavior). On an older Node, compile src/mcp/tests to a
// scratch directory with the TypeScript that is already a devDependency and run
// the same suite there. Same tests, same assertions, no new dependency.
//
// The scratch tree gets symlinks back to the data the tests read relative to
// themselves (cards/, contracts/, package.json, dist/, bin/), so a test's
// `new URL("../cards/...", import.meta.url)` resolves to the real file.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();

/** Node gained `--experimental-strip-types` in 22.6 (and 20.x never had it). */
function canStripTypes() {
  // Set CONIFER_TEST_COMPILE=1 to exercise the compile path on a modern Node,
  // which is how CI proves the Node 20 route still works without a Node 20.
  if (process.env.CONIFER_TEST_COMPILE === "1") return false;
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 6);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function stripTypesRun() {
  const flags = ["--experimental-strip-types"];
  // Node 22 prints a type-stripping ExperimentalWarning per file; 23+ does not.
  if (Number(process.versions.node.split(".")[0]) < 23) flags.push("--no-warnings");
  return run(process.execPath, [
    ...flags,
    "--test",
    ...testFiles.map((name) => join("tests", name)),
  ]);
}

function compiledRun() {
  const out = join(root, ".test-build");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const tsc = join(root, "node_modules", ".bin", "tsc");
  if (!existsSync(tsc)) {
    console.error(
      `\nNode ${process.versions.node} cannot run TypeScript directly, so the suite is\n` +
        "compiled first — but node_modules/.bin/tsc is missing. Run `npm ci`.\n",
    );
    return 1;
  }

  console.log(
    `Node ${process.versions.node} has no type stripping; compiling the suite to ` +
      ".test-build (Node >= 22.6 skips this and runs the sources directly).",
  );
  try {
    execFileSync(
      tsc,
      [
        "-p",
        "tsconfig.json",
        "--noEmit",
        "false",
        "--outDir",
        ".test-build",
        "--rootDir",
        ".",
        "--allowImportingTsExtensions",
        "false",
        "--rewriteRelativeImportExtensions",
        "--module",
        "nodenext",
        "--sourceMap",
      ],
      { cwd: root, stdio: "inherit" },
    );
  } catch {
    return 1;
  }

  // The tests read repo data by a path relative to themselves (cards/,
  // contracts/, package.json, scripts/, python/…). Rather than curate a list
  // that silently goes stale the moment a test reads something new — which is
  // exactly how this fallback would rot — link EVERY top-level entry that the
  // compile did not itself produce. A missing link is an ENOENT in a suite
  // that passes on the fast path, i.e. the worst kind of drift.
  const produced = new Set(["src", "mcp", "tests"]);
  for (const entry of readdirSync(root)) {
    if (produced.has(entry) || entry === ".test-build") continue;
    try {
      symlinkSync(join(root, entry), join(out, entry));
    } catch {
      /* already linked */
    }
  }

  return run(process.execPath, [
    "--test",
    ...testFiles.map((name) => join(".test-build", "tests", name.replace(/\.ts$/, ".js"))),
  ]);
}

const status = canStripTypes() ? stripTypesRun() : compiledRun();
process.exit(status);
