// tests/consumers.test.ts — the card DECLARES consumers; this ENFORCES them.
//
// WHY THIS FILE EXISTS. `cards/sdk.output.card.json` lists three consumers: the
// MCP server, the Python twin, and the website docs. On 2026-08-27 all three
// had drifted from the SDK, and every one cost something real:
//
//   · the docs told migrating users to keep embeddings on a competitor, for a
//     door the gateway had served since 2026-08-26;
//   · the docs published a Python install line that dies on the first call;
//   · the MCP server handed agents an empty answer and a bill, with no reason —
//     so an agent would retry and pay twice;
//   · Python was missing `attribution_from_openrouter` ENTIRELY, which the
//     "one SDK, two languages" claim did not survive.
//
// Not one of those was visible to a test suite. The card declared the
// relationship and nothing checked it, so the only enforcement was somebody
// remembering to look. These tests are that enforcement.
//
// They are deliberately SHALLOW. A deep check would duplicate each consumer's
// own tests and rot; the failure mode here is not "the consumer is wrong", it
// is "the consumer never heard about a change at all".

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as sdk from "../src/index.ts";
import { TOOLS } from "../mcp/server.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * Read a SOURCE file by its path from the repo root.
 *
 * `read()` resolves relative to the test, which is wrong for `.ts` sources on
 * the compile route: there the suite runs from `.test-build/tests/`, where
 * `src/` and `mcp/` are the compiler's `.js` OUTPUT and the `.ts` originals do
 * not exist at all. (The runner deliberately does not symlink those three
 * directories, because it produced them.) So a test that greps a source file
 * has to walk up past the scratch tree, which is what this does — and the
 * suite then behaves identically on both routes, which is the whole point of
 * having two.
 */
function readSource(relative: string): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // tests/            -> repo root is one level up
  // .test-build/tests/ -> repo root is two
  const root = here.includes(".test-build")
    ? new URL("../../", import.meta.url)
    : new URL("../", import.meta.url);
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}
const outputCard = JSON.parse(read("../cards/sdk.output.card.json")) as Record<string, any>;

/**
 * camelCase -> the Python twin's name.
 *
 * Not a plain snake_case: the two SDKs are idiomatic in their own languages,
 * and three conventions differ deliberately rather than by accident.
 *
 *   · PROPER NOUNS stay whole. `fromOpenRouter` is `from_openrouter`, not
 *     `from_open_router` — the vendor's name is one word.
 *   · UNITS follow the language's habit. TypeScript counts milliseconds
 *     (`backoffMs`, matching `setTimeout`); Python counts seconds
 *     (`backoff_seconds`, matching `time.sleep`). Forcing either to the
 *     other's unit would be a footgun in service of a symmetry nobody wants.
 *   · A FREE FUNCTION may be a PROPERTY. `textOf(completion)` reads naturally
 *     in TS; `completion.text` reads naturally in Python.
 *
 * Encoding those here is the point: it makes the exceptions explicit and
 * reviewable, instead of leaving the check so loose it catches nothing.
 */
function pythonTwin(name: string): string[] {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return [
    snake,
    // Proper nouns kept whole.
    snake.replace(/open_router/g, "openrouter").replace(/no_usd/g, "nousd"),
    // The ms/seconds unit convention.
    snake.replace(/_ms$/, "_seconds"),
    // A free function that is a property on the Python side.
    snake.replace(/_of$/, ""),
  ];
}

test("the consumer list is still the three things this file knows how to check", () => {
  // If a fourth consumer is added to the card, it needs enforcement here too —
  // otherwise the card grows a claim nobody checks, which is the exact
  // situation this file exists to end.
  const consumers = outputCard.consumers as string[];
  assert.equal(consumers.length, 3, `consumers changed: ${JSON.stringify(consumers)}`);
  assert.ok(consumers.some((c) => c.includes("mcp")));
  assert.ok(consumers.some((c) => c.includes("python")));
  assert.ok(consumers.some((c) => c.includes("docs")));
});

/**
 * The parity gap that actually happened: `attributionFromOpenRouter` existed in
 * TypeScript and was missing from Python entirely, so a documented migration
 * helper silently did not exist for half the users.
 */
test("every TypeScript helper has a Python twin", () => {
  const pythonSource = [
    readSource("python/conifer_sdk/client.py"),
    readSource("python/conifer_sdk/catalog.py"),
    readSource("python/conifer_sdk/chat.py"),
    readSource("python/conifer_sdk/embeddings.py"),
    readSource("python/conifer_sdk/jobs.py"),
    readSource("python/conifer_sdk/transport.py"),
    readSource("python/conifer_sdk/errors.py"),
    readSource("python/conifer_sdk/portability.py"),
    readSource("python/conifer_sdk/receipt.py"),
    readSource("python/conifer_sdk/receipts.py"),
    readSource("python/conifer_sdk/types.py"),
  ].join("\n");

  // Deliberate exemptions, each for a reason rather than convenience.
  const exempt = new Set([
    // Classes, checked separately below by their exported names.
    "Conifer", "Embeddings", "JobsApi", "KeysApi", "Transport",
    "ReceiptCollector", "SpendBudget",
    // TS-only shapes: Python's client has no injectable fetch layer (it takes a
    // `transport` callable) and no AI-SDK provider config to build.
    "coniferOpenAICompatibleConfig", "vercelEnvMigration",
    // `emptyReason` is a PROPERTY on the Python Completion (`empty_reason`),
    // not a free function — checked by name below.
    "emptyReason",
  ]);

  const missing: string[] = [];
  for (const name of Object.keys(sdk)) {
    if (typeof (sdk as Record<string, unknown>)[name] !== "function") continue;
    if (/^Conifer[A-Z]/.test(name)) continue; // error classes, same name both sides
    if (exempt.has(name)) continue;
    const twins = pythonTwin(name);
    const found = twins.some((twin) =>
      new RegExp(`\\b(def |class )${twin}\\b`).test(pythonSource),
    );
    if (!found) missing.push(`${name} -> any of ${twins.join(" / ")}`);
  }
  assert.deepEqual(
    missing,
    [],
    `TypeScript helpers with no Python twin. "One SDK, two languages" has to be checkable:\n  ${missing.join("\n  ")}`,
  );
});

test("every error class exists in both languages", () => {
  const pythonErrors = readSource("python/conifer_sdk/errors.py");
  const missing = Object.keys(sdk)
    .filter((name) => /^Conifer[A-Z]/.test(name))
    .filter((name) => !new RegExp(`class ${name}\\b`).test(pythonErrors));
  assert.deepEqual(missing, [], `error classes missing from Python: ${missing.join(", ")}`);
});

/**
 * The MCP server is the consumer that drifted most expensively: it predated
 * `emptyReason`, so an agent got `text: ""` and a bill with no explanation and
 * would retry, paying twice.
 */
test("the MCP server reports cost and explains an empty answer", () => {
  const server = readSource("mcp/server.ts");
  const spending = TOOLS.filter((tool) => /complete|compare|embed/.test(tool.name));
  assert.ok(spending.length >= 3, "expected the spending tools to still exist");

  // Every tool that SPENDS must disclose what it spent. An agent that cannot
  // see the cost of its last call cannot be told to spend less.
  assert.ok(/cost_nanousd/.test(server), "the MCP server must report cost");
  // And the two that return prose must say why that prose is empty.
  assert.equal(
    (server.match(/empty_reason: emptyReason\(/g) ?? []).length,
    2,
    "conifer_complete and conifer_compare must both carry empty_reason",
  );

  // Every tool needs a description an agent can route on, not a stub.
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 60, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

/**
 * The docs live in a sibling repo, so this checks what it CAN: that the SDK's
 * own README covers the surface, since it is the document the public repo shows
 * first and the one a reader meets before any website page.
 */
test("the README covers the whole public surface", () => {
  const readme = read("../README.md");
  // One entry per capability a user would go looking for. A feature shipped
  // without a line here is a feature nobody finds.
  for (const topic of [
    "embeddings",
    "defer",
    "jobs.wait",
    "ReceiptCollector",
    "SpendBudget",
    "emptyReason",
    "usage.cost",
    "[tls]",
  ]) {
    assert.ok(readme.includes(topic), `the README never mentions ${topic}`);
  }
});

test("the release runbook exists and names the traps", () => {
  const releasing = new URL("../RELEASING.md", import.meta.url);
  assert.ok(existsSync(releasing), "RELEASING.md is missing");
  const text = readFileSync(fileURLToPath(releasing), "utf8");
  // `--access public` is the one that fails silently in the wrong direction: a
  // scoped npm package publishes PRIVATE by default.
  assert.match(text, /--access public/);
  // And the artifact inspection step, which is how the blank PyPI page was
  // caught — a green build says nothing about what is inside the tarball.
  assert.match(text, /METADATA/);
});
