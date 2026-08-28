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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { VERSION } from "../src/index.ts";
import { TOOLS } from "../mcp/server.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// The REPO root, which is not always `root`: under CONIFER_TEST_COMPILE=1 the
// suite runs from .test-build/, a copy where every .ts source has become .js.
// The runner sets cwd to the repo in both modes, so a test that must read a
// SOURCE file (rather than a copied artifact) resolves from here.
const repoRoot = process.cwd();
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

test("the `bin` path has no `./` prefix, so the registry keeps the binary", () => {
  // npm VALIDATES bin paths on publish and SILENTLY DROPS any entry whose
  // value it considers invalid — a leading "./" is exactly that. The failure
  // is invisible locally: `npm pack` keeps the "./" form, a tarball install
  // links node_modules/.bin/conifer-mcp fine, and every offline test passes.
  // Only the PUBLISHED package loses the bin, so `npx conifer-mcp` and every
  // MCP client config pointing at it break for everyone but us.
  //
  // Caught 2026-08-27 while publishing 0.1.0: npm printed
  //   `"bin[conifer-mcp]" script name bin/conifer-mcp.mjs was invalid and removed`
  // as a WARNING inside a wall of publish output, and would have shipped a
  // package whose advertised MCP entry point did not exist.
  for (const [name, path] of Object.entries(pkg.bin as Record<string, string>)) {
    assert.ok(
      !path.startsWith("./"),
      `bin[${name}] is "${path}" — npm strips entries with a "./" prefix on publish; use "${path.slice(2)}"`,
    );
  }
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
  // The count is asserted against the built dist/, not the sources, so a tool
  // added to mcp/server.ts without a rebuild fails here rather than shipping
  // a package whose advertised surface differs from its compiled one.
  assert.equal(reply.result.tools.length, TOOLS.length);
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

/**
 * The Python package must offer the CA-bundle escape hatch, and must NOT make
 * it mandatory.
 *
 * Found in a fresh-venv install test: a python.org macOS install whose
 * "Install Certificates.command" was never run has an EMPTY trust store, and so
 * does every venv built on it. It cannot verify any HTTPS host, so the SDK's
 * very first call dies with CERTIFICATE_VERIFY_FAILED — which is how a new user
 * would have met this package. `[tls]` is the one-command fix.
 *
 * It stays an EXTRA because zero runtime dependencies is a real feature (this
 * drops into a lambda or a locked-down build image with no package tree to
 * audit), and most environments already have a working store.
 */
test("the Python package offers a `tls` extra without depending on it", () => {
  const pyproject = readFileSync(
    fileURLToPath(new URL("../python/pyproject.toml", import.meta.url)),
    "utf8",
  );
  // The runtime dependency list must stay empty.
  assert.match(pyproject, /dependencies = \[\]/);
  // And the escape hatch must exist, spelled the way the README tells people.
  assert.match(pyproject, /tls = \["certifi"\]/);
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /\[tls\]/, "the README must document the extra it tells people to install");
});

/**
 * The Python package must actually SHIP a description.
 *
 * Found by inspecting a built wheel rather than trusting the build's exit code:
 * `readme = "README.md"` named a file that did not exist in `python/`, and
 * setuptools resolved it to nothing WITHOUT a warning. The build succeeded, the
 * metadata carried `Description-Content-Type: text/markdown`, and the body was
 * EMPTY — which renders as a blank PyPI project page. On a launch, the first
 * thing most people would have seen of this SDK is nothing at all.
 *
 * The fix is a symlink to the repo README, because two copies of a 400-line
 * document drift and the stale one is always the one a user reads. (A relative
 * `../README.md` does not work: setuptools refuses to read outside the package
 * root, and fails the build loudly.)
 */
test("the Python package ships the README it declares", () => {
  const readme = new URL("../python/README.md", import.meta.url);
  assert.ok(existsSync(readme), "python/README.md is missing — PyPI would render a blank page");

  // It must be the SAME document, not a copy that can drift.
  const shipped = readFileSync(fileURLToPath(readme), "utf8");
  const canonical = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.equal(shipped, canonical, "python/README.md has drifted from the repo README");
  assert.ok(shipped.length > 1000, "the shipped README is suspiciously short");

  // And the declaration must point at it by the name setuptools can resolve.
  const pyproject = readFileSync(
    fileURLToPath(new URL("../python/pyproject.toml", import.meta.url)),
    "utf8",
  );
  assert.match(pyproject, /readme = "README\.md"/);
});

test("the two packages carry the same version", () => {
  // `package.json` and `pyproject.toml` have no shared source of truth, so a
  // mismatched pair ships silently — and then `pip install conifer-sdk==0.2.0`
  // and `npm i conifer-sdk@0.2.0` are different software under one name,
  // which is the sort of thing nobody debugs quickly.
  const npmVersion = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).version as string;
  const pyproject = readFileSync(
    fileURLToPath(new URL("../python/pyproject.toml", import.meta.url)),
    "utf8",
  );
  const pyVersion = /^version = "([^"]+)"/m.exec(pyproject)?.[1];
  assert.equal(
    pyVersion,
    npmVersion,
    `python/pyproject.toml is ${pyVersion} but package.json is ${npmVersion}`,
  );
});

test("the RUNTIME version constants match the manifests", () => {
  // A version a user can read is only useful if it is TRUE. Both constants are
  // literals (see src/version.ts for why a package.json read is worse), so
  // nothing but this test stops a release from bumping the manifests and
  // shipping a client that reports the previous version in its bug reports.
  //
  // Four values, one truth: package.json, pyproject.toml, VERSION, __version__.
  const npmVersion = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).version as string;

  // repoRoot, not root: version.ts is a SOURCE file, and under
  // CONIFER_TEST_COMPILE=1 `root` is .test-build/ where it exists only as .js.
  const tsSource = readFileSync(join(repoRoot, "src", "version.ts"), "utf8");
  const tsVersion = /export const VERSION = "([^"]+)"/.exec(tsSource)?.[1];
  assert.equal(
    tsVersion,
    npmVersion,
    `src/version.ts exports ${tsVersion} but package.json is ${npmVersion}`,
  );

  const pySource = readFileSync(join(root, "python", "conifer_sdk", "__init__.py"), "utf8");
  const pyRuntime = /^__version__ = "([^"]+)"/m.exec(pySource)?.[1];
  assert.equal(
    pyRuntime,
    npmVersion,
    `conifer_sdk.__version__ is ${pyRuntime} but package.json is ${npmVersion}`,
  );
});

test("VERSION is exported from the package entry point", () => {
  // The constant is worthless if it is not reachable by the name the docs
  // promise. This imports the SAME public seam a consumer does, so deleting
  // the re-export from index.ts fails here rather than in someone's editor.
  assert.equal(typeof VERSION, "string", "VERSION is not exported from src/index.ts");
  assert.match(
    VERSION,
    /^\d+\.\d+\.\d+(?:[-+].+)?$/,
    `VERSION is not a semver string: ${VERSION}`,
  );
});

test("the README does not claim a registry that has no package", () => {
  // Leaving "not on a registry" in after publishing — or removing it before —
  // is the kind of small dishonesty that costs trust on the day it matters.
  // RELEASING.md makes updating it a step; this makes forgetting it visible.
  //
  // Both ecosystems shipped 2026-08-27 (npm, then PyPI), so both halves now
  // assert the same shape: show the install, do not deny the package exists.
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

  const claimsNotOnNpm = /not on npm/i.test(readme);
  const showsNpmInstall = /npm i (conifer-sdk|@conifer\/sdk)(?!\.)/.test(readme);
  assert.ok(
    claimsNotOnNpm !== showsNpmInstall,
    "README both claims not-on-npm AND shows an npm registry install (or neither).",
  );

  const claimsNotOnPypi = /not on PyPI/i.test(readme);
  const showsPypiInstall = /pip install "?conifer-sdk/.test(readme);
  assert.ok(
    claimsNotOnPypi !== showsPypiInstall,
    "README both claims not-on-PyPI AND shows a PyPI install (or neither).",
  );
});

test("CHANGELOG.md passes its own structural gate", () => {
  // scripts/check-changelog.mjs is the gate; this test is what makes it
  // UNSKIPPABLE. A check that only runs when someone remembers the command is
  // not a check, and CI running it separately still leaves a local `npm test`
  // green on a changelog that would fail the build.
  //
  // The script owns the rules and the error messages; this only asserts it
  // exits 0. Its own negative cases were exercised by hand against a
  // deliberately broken changelog (raw commit subjects, a cited SHA, an empty
  // category, a future date, a missing link reference).
  const script = join(root, "scripts", "check-changelog.mjs");
  assert.ok(existsSync(script), "scripts/check-changelog.mjs is missing");
  // execFileSync throws on a non-zero exit, which IS the assertion.
  execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
});

test("the CHANGELOG documents the version being shipped", () => {
  // The gate above proves the file is well-formed; this proves it is CURRENT.
  // A release that bumps package.json without a changelog entry is the single
  // most common way a changelog stops being trustworthy.
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.ok(
    changelog.includes(`## [${pkg.version}]`),
    `CHANGELOG.md has no section for ${pkg.version}, the version in package.json`,
  );
});

test("CHANGELOG.md ships inside the package", () => {
  // A changelog the registry page cannot show is a changelog most users never
  // read: `npm i` gives them the tarball, not the repo.
  assert.ok(
    (pkg.files as string[]).includes("CHANGELOG.md"),
    "CHANGELOG.md is not in package.json 'files', so it is excluded from the tarball",
  );
});

test("CI actually tests the version floors the package advertises", () => {
  // `engines.node` and `requires-python` are PROMISES. The way they become
  // lies is silent: someone raises a floor, or adds a syntax feature that the
  // floor cannot parse, and nothing fails because CI happens to run a newer
  // runtime. This asserts the promise and the matrix agree — the floor version
  // itself must appear in the CI matrix, so the oldest supported runtime is
  // exercised on every pull request rather than assumed.
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");

  const nodeFloor = /(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
  assert.ok(nodeFloor, "package.json declares no engines.node floor");
  const nodeMatrix = /node:\s*\[([^\]]+)\]/.exec(workflow)?.[1] ?? "";
  const nodeVersions = [...nodeMatrix.matchAll(/"(\d+)"/g)].map((m) => m[1]);
  assert.ok(
    nodeVersions.includes(nodeFloor),
    `engines.node is >=${nodeFloor} but the CI matrix (${nodeVersions.join(", ")}) ` +
      "never runs that version — the floor is untested.",
  );

  const pyproject = readFileSync(join(root, "python", "pyproject.toml"), "utf8");
  const pyFloor = /requires-python = ">=([\d.]+)"/.exec(pyproject)?.[1];
  assert.ok(pyFloor, "pyproject.toml declares no requires-python floor");
  const pyMatrix = /python:\s*\[([^\]]+)\]/.exec(workflow)?.[1] ?? "";
  const pyVersions = [...pyMatrix.matchAll(/"([\d.]+)"/g)].map((m) => m[1]);
  assert.ok(
    pyVersions.includes(pyFloor),
    `requires-python is >=${pyFloor} but the CI matrix (${pyVersions.join(", ")}) ` +
      "never runs that version — the floor is untested.",
  );
});

test("the @conifer/sdk alias tracks this exact version", () => {
  // alias/ is the scope-defending package: it re-exports conifer-sdk so the
  // @conifer scope cannot be squatted (see RELEASING.md). It pins an EXACT
  // dependency version, which means a bump here without a bump there ships a
  // scoped package that quietly installs an older SDK than its own version
  // number claims — the exact confusion the alias exists to prevent.
  const alias = JSON.parse(readFileSync(join(repoRoot, "alias", "package.json"), "utf8"));

  assert.equal(alias.name, "@conifer/sdk", "the alias must hold the scoped name");
  assert.equal(
    alias.version,
    pkg.version,
    `alias/package.json is ${alias.version} but the SDK is ${pkg.version}`,
  );
  assert.equal(
    alias.dependencies?.["conifer-sdk"],
    pkg.version,
    `the alias depends on conifer-sdk@${alias.dependencies?.["conifer-sdk"]}, ` +
      `not the ${pkg.version} it ships beside. Pin it exactly.`,
  );

  // It must stay a re-export, not a fork with its own behavior.
  const entry = readFileSync(join(repoRoot, "alias", "index.js"), "utf8");
  assert.match(
    entry,
    /export \* from "conifer-sdk"/,
    "the alias must re-export conifer-sdk verbatim",
  );

  // And it must tell the reader where the real package is.
  const readme = readFileSync(join(repoRoot, "alias", "README.md"), "utf8");
  assert.match(readme, /conifer-sdk/, "the alias README must name the real package");
});

test("the scope-blocked runbook stays honest about the alias's state", () => {
  // docs/npm-scope-blocked.md says @conifer/sdk is NOT published. The day it
  // IS published that sentence becomes the misleading kind of stale doc — it
  // would send someone to a support ticket for a problem that no longer
  // exists. This cannot check npm from an offline test, so it checks the two
  // things it can: the runbook exists, and RELEASING.md still points at it.
  //
  // When the alias goes live: delete the runbook, drop the "not published yet"
  // paragraph from RELEASING.md, and delete this test. All three together.
  const runbook = join(repoRoot, "docs", "npm-scope-blocked.md");
  assert.ok(existsSync(runbook), "docs/npm-scope-blocked.md is missing");

  const releasing = readFileSync(join(repoRoot, "RELEASING.md"), "utf8");
  assert.match(
    releasing,
    /docs\/npm-scope-blocked\.md/,
    "RELEASING.md no longer links the scope runbook — if the scope was fixed, " +
      "delete the runbook and this test too; do not leave a dangling reference.",
  );

  // The runbook must carry the actual evidence, not just an assertion, or it
  // is useless to whoever picks this up cold.
  const text = readFileSync(runbook, "utf8");
  for (const marker of ["/-/org/conifer/team", "404", "alias/"]) {
    assert.ok(text.includes(marker), `the runbook no longer explains '${marker}'`);
  }
});

test("the contributor path documents the rules CI enforces", () => {
  // A rule that fails a first-time contributor's PR while being written down
  // NOWHERE is a hostile first experience. The changelog gate is exactly that
  // kind of rule: invisible until it rejects you. CONTRIBUTING.md must explain
  // it, and the PR template must remind you at the moment you would forget.
  const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
  assert.match(
    contributing,
    /CHANGELOG\.md/,
    "CONTRIBUTING.md never mentions CHANGELOG.md, but npm test fails without an entry",
  );
  assert.match(
    contributing,
    /Unreleased/,
    "CONTRIBUTING.md does not say WHERE to add an entry",
  );

  const prTemplate = join(repoRoot, ".github", "pull_request_template.md");
  assert.ok(existsSync(prTemplate), ".github/pull_request_template.md is missing");
  assert.match(
    readFileSync(prTemplate, "utf8"),
    /CHANGELOG\.md/,
    "the PR template does not mention the changelog entry CI requires",
  );
});

test("the bug template asks for the version the SDK exposes", () => {
  // VERSION and __version__ exist so a bug report can name what ran. That only
  // pays off if the report ASKS for it — otherwise the constant is a feature
  // nobody uses and every triage starts with a round trip.
  const bug = readFileSync(
    join(repoRoot, ".github", "ISSUE_TEMPLATE", "bug.yml"),
    "utf8",
  );
  assert.match(bug, /VERSION|__version__/, "the bug template does not ask for the SDK version");
});

test("the GitHub YAML files parse", () => {
  // A malformed issue template does not fail a build: GitHub silently falls
  // back to a blank issue form, and nobody notices until reports stop carrying
  // the fields. Parsed here with a real YAML parser, since the repo has no
  // other YAML coverage.
  //
  // Deliberately a SUBSET parse: enough to catch indentation and structure
  // errors, which is the whole failure mode. Node has no bundled YAML, so this
  // shells out to python3 — present in CI, and this repo already requires it.
  const files = [
    join(repoRoot, ".github", "workflows", "ci.yml"),
    join(repoRoot, ".github", "ISSUE_TEMPLATE", "bug.yml"),
    join(repoRoot, ".github", "ISSUE_TEMPLATE", "config.yml"),
    join(repoRoot, ".github", "ISSUE_TEMPLATE", "integration.yml"),
  ];
  for (const f of files) assert.ok(existsSync(f), `${f} is missing`);

  const probe = "import yaml,sys\n[yaml.safe_load(open(p)) for p in sys.argv[1:]]\n";
  try {
    execFileSync("python3", ["-c", probe, ...files], { stdio: "pipe" });
  } catch (err) {
    const text = String((err as { stderr?: Buffer }).stderr ?? err);
    // No PyYAML is not a repo defect; a PARSE failure is.
    if (/ModuleNotFoundError|No module named/.test(text)) return;
    assert.fail(`a .github YAML file does not parse:\n${text}`);
  }
});
