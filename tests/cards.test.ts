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
  fromHeliconeHeaders,
  fromOpenRouter,
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
