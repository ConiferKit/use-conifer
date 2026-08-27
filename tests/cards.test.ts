// tests/cards.test.ts — the cards are the contract, so they are tested.
//
// The card architecture's swap test only holds if the cards actually describe
// the logic. These tests bind them: a header renamed in code without its card
// entry, or a portability field documented but not enforced, fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ConiferPortabilityError,
  chatHeaders,
  embeddingsBody,
  embeddingsHeaders,
  fromHeliconeHeaders,
  fromOpenRouter,
  attributionFromOpenRouter,
  readReceipt,
} from "../src/index.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const card = (name: string) =>
  JSON.parse(readFileSync(here(`../cards/${name}`), "utf8")) as Record<string, any>;

const input = card("sdk.input.card.json");
const output = card("sdk.output.card.json");
const portability = card("portability.card.json");

/**
 * The gateway's own generated wire contract, vendored at
 * `contracts/gateway-contract.json` and pinned by byte.
 *
 * Vendoring is deliberate. An earlier version read the artifact out of a
 * sibling checkout of the gateway repo, and picked up a stale copy that was two
 * receipt headers behind — so this test passed while production sent
 * `x-conifer-receipt-venue` and `x-conifer-counterfactual-nanousd` that the SDK
 * silently dropped. Pinning the wrong copy of a contract is indistinguishable
 * from having no pin at all. A vendored file also means this suite runs offline
 * in any clone, which is what makes the repo contributable.
 */
const gatewayContract = JSON.parse(
  readFileSync(here("../contracts/gateway-contract.json"), "utf8"),
) as { receipt_headers: string[]; request_id_header: string; timeouts_secs: Record<string, number> };

test("the SDK parses exactly the receipt headers the gateway emits", () => {
  const headers = new Headers();
  for (const name of gatewayContract.receipt_headers) headers.set(name, "1");
  headers.set(gatewayContract.request_id_header, "req-1");
  const receipt = readReceipt(headers);

  // Every gateway receipt header must land on a parsed field.
  const populated = Object.entries(receipt)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  for (const expected of [
    "requestedModel",
    "effectiveModel",
    "reason",
    "endpoint",
    "costNanoUsd",
    "serviceTier",
    "receiptVenue",
    "counterfactualNanoUsd",
    "requestId",
  ]) {
    assert.ok(populated.includes(expected), `${expected} must be parsed`);
  }
});

test("the output card names every receipt header the gateway emits", () => {
  const documented = JSON.stringify(output.completion.receipt);
  for (const name of [...gatewayContract.receipt_headers, gatewayContract.request_id_header]) {
    assert.ok(documented.includes(name), `${name} is emitted but undocumented`);
  }
});

test("the client timeout is the gateway's own edge silent-cut", async () => {
  const { DEFAULT_TIMEOUT_MS } = await import("../src/client.ts");
  assert.equal(
    DEFAULT_TIMEOUT_MS,
    (gatewayContract.timeouts_secs.edge_silent_cut as number) * 1000,
    "giving up before the gateway does abandons a turn that is still being served and billed",
  );
});

test("every header the input card claims is actually sent", () => {
  const sent = chatHeaders(
    {
      model: "m",
      messages: [],
      maxCostNanoUsd: 1,
      deadlineSeconds: 1,
      defer: true,
      venue: "cloud",
      promptCache: "off",
      requestId: "r",
      client: "c",
    },
    "idem",
  );
  const claimed = Object.values(input.request_options)
    .map((option: any) => option?.wire as string | undefined)
    .filter((wire): wire is string => typeof wire === "string" && wire.includes("header"))
    .flatMap((wire) => wire.match(/x-[a-z-]+|idempotency-key/g) ?? []);

  for (const name of new Set(claimed)) {
    assert.ok(name in sent, `the card claims ${name} but the client never sends it`);
  }
});

/**
 * The embeddings door gets the same card binding as chat: a header renamed in
 * code without its card entry, or a body field the card claims and the client
 * never sends, fails here rather than in a user's integration.
 */
test("every embeddings field the input card claims is actually on the wire", () => {
  const headers = embeddingsHeaders(
    { model: "m", input: "hi", maxCostNanoUsd: 1, requestId: "r", client: "c" },
    "idem",
  );
  const body: Record<string, unknown> = embeddingsBody({
    model: "m",
    input: "hi",
    dimensions: 8,
    user: "u",
  });

  for (const [field, spec] of Object.entries(input.embeddings_request)) {
    const wire = (spec as { wire?: string })?.wire;
    if (typeof wire !== "string") continue; // the prose `note` key
    for (const name of wire.match(/x-[a-z-]+|idempotency-key/g) ?? []) {
      assert.ok(name in headers, `the card claims ${name} for ${field}, but it is never sent`);
    }
    const bodyField = wire.startsWith("body.") ? wire.slice("body.".length) : undefined;
    if (bodyField !== undefined) {
      assert.ok(
        bodyField in body,
        `the card maps ${field} to body.${bodyField}, but the client never sends it`,
      );
    }
  }
});

test("the card's base64 claim matches what the client actually requests", () => {
  // The card documents `encoding_format` as defaulting to base64 and being
  // decoded transparently. That is a promise about bytes AND about money
  // (~3x less egress), so it is checked rather than described.
  const spec = (input.embeddings_request as any).encodingFormat.note as string;
  assert.match(spec, /base64/);
  assert.equal(embeddingsBody({ model: "m", input: "hi" }).encoding_format, "base64");
  // And it must remain overridable, or the "raw provider bytes" escape hatch
  // the card promises would not exist.
  assert.equal(
    embeddingsBody({ model: "m", input: "hi", encodingFormat: "float" }).encoding_format,
    "float",
  );
});

test("every HEADER the card calls unsupported refuses through its own door", () => {
  // Headers are refused by `attributionFromOpenRouter`, not by the body
  // converter, so they live in their own card section and are driven through
  // their own entry point. Mixing them made the body-driven test fail on a
  // header it could never have refused — a small mistake the gate caught.
  for (const name of Object.keys(portability.openrouter.unsupported_refused_headers)) {
    if (name === "note") continue;
    assert.throws(
      () => attributionFromOpenRouter({ [name]: "x" }),
      ConiferPortabilityError,
      `openrouter header ${name} is documented as refused but does not refuse`,
    );
  }
});

test("every field the portability card calls unsupported actually refuses", () => {
  const openRouterFields = Object.keys(portability.openrouter.unsupported_refused).filter(
    // The sampling-knob entry is a slash-joined group, handled below.
    (field) => !field.includes("/"),
  );
  for (const field of openRouterFields) {
    assert.throws(
      () => fromOpenRouter({ model: "m", messages: [], [field]: "x" } as any),
      ConiferPortabilityError,
      `openrouter.${field} is documented as refused but does not refuse`,
    );
  }

  for (const field of Object.keys(portability.helicone.unsupported_refused)) {
    if (field.endsWith("*")) continue; // wildcard families are covered by name below
    assert.throws(
      () => fromHeliconeHeaders({ [field.split(" / ")[0] as string]: "x" }),
      ConiferPortabilityError,
      `helicone.${field} is documented as refused but does not refuse`,
    );
  }
});

test("the cards declare their consumers, so the swap test has a list", () => {
  assert.ok(Array.isArray(output.consumers) && output.consumers.length > 0);
  assert.ok(portability.law.length >= 3, "the migration law must be stated, not implied");
});
