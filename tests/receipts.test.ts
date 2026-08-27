// tests/receipts.test.ts — receipts for the client you ALREADY use.
//
// The property under test is mostly a NEGATIVE one: the wrapper must observe a
// response without changing it in any way the caller can detect. A wrapper that
// consumed the body to read a cost would break streaming and double memory for
// everyone, and it would do so silently — the caller's `.json()` would just
// start throwing "body already read" somewhere far from here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ReceiptCollector, SpendBudget } from "../src/index.ts";

/** The receipt headers a real chat turn carries, measured 2026-08-27. */
const RECEIPT = {
  "x-conifer-effective-model": "claude-fable-5",
  "x-conifer-cost-nanousd": "580000",
  "x-conifer-cost-components-nanousd": "fresh=80000,cache_write=0,cache_read=0,output=500000",
  "x-conifer-request-id": "gw-1",
};

function respond(body: unknown, headers: Record<string, string> = RECEIPT) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const stub = (responses: Response[]) => (async () => {
  const next = responses.shift();
  if (next === undefined) throw new Error("no scripted response left");
  return next;
}) as any;

test("the receipt is captured without disturbing the caller's body", async () => {
  const collector = new ReceiptCollector({
    fetch: stub([respond({ choices: [{ message: { content: "pinecone" } }] })]),
  });
  const response = await collector.fetch("https://api.conifer.build/v1/chat/completions", {
    method: "POST",
    headers: {},
  });

  // The body must still be fully readable: we only ever touched headers.
  const parsed = (await response.json()) as any;
  assert.equal(parsed.choices[0].message.content, "pinecone");

  assert.equal(collector.last?.costNanoUsd, 580_000);
  assert.equal(collector.last?.effectiveModel, "claude-fable-5");
  assert.deepEqual(collector.last?.costComponentsNanoUsd, {
    fresh: 80_000,
    cacheWrite: 0,
    cacheRead: 0,
    output: 500_000,
  });
  assert.equal(collector.last?.url, "https://api.conifer.build/v1/chat/completions");
});

test("a streaming body is left unread, so the stream still flows", async () => {
  // The bug this prevents: reading the body here to find a cost would consume
  // the single-use stream, and the caller's reader would get nothing.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      controller.close();
    },
  });
  const collector = new ReceiptCollector({
    fetch: stub([new Response(stream, { status: 200, headers: RECEIPT })]),
  });
  const response = await collector.fetch("https://api.conifer.build/v1/chat/completions", {
    method: "POST",
    headers: {},
  });

  assert.equal(response.bodyUsed, false, "the wrapper must not consume the body");
  const text = await response.text();
  assert.match(text, /data:/);
  // And the routing half of the receipt was still captured off the head.
  assert.equal(collector.last?.effectiveModel, "claude-fable-5");
});

test("a response with no receipt is ignored rather than counted as free", async () => {
  // Not every call through a wrapped client is an inference turn — a `/models`
  // read, a health check, an unrelated host. Counting those as zero-cost turns
  // would quietly deflate the average cost per turn.
  const collector = new ReceiptCollector({ fetch: stub([respond({ ok: true }, {})]) });
  await collector.fetch("https://example.com/health", { method: "GET", headers: {} });
  assert.equal(collector.total.turns, 0);
  assert.equal(collector.last, undefined);
});

test("the total sums exactly, in integers, across turns", async () => {
  const collector = new ReceiptCollector({
    fetch: stub([
      respond({}, { ...RECEIPT, "x-conifer-cost-nanousd": "580000" }),
      respond({}, { ...RECEIPT, "x-conifer-cost-nanousd": "590000" }),
    ]),
  });
  await collector.fetch("u", { method: "POST", headers: {} });
  await collector.fetch("u", { method: "POST", headers: {} });

  const total = collector.total;
  assert.equal(total.turns, 2);
  // Integer nanodollars, never floating dollars: 0.00058 + 0.00059 in floats
  // is not 0.00117, and money that does not add up is worse than no money.
  assert.equal(total.costNanoUsd, 1_170_000);
  assert.equal(total.costUsd, "0.001170000");
});

test("the counterfactual is summed over its OWN subset, and says so", async () => {
  // The gateway omits this header unless the routed predicate holds, so a
  // naive sum invites comparing it against a cost drawn from more turns and
  // reporting a savings number that was never true.
  const collector = new ReceiptCollector({
    fetch: stub([
      respond({}, { ...RECEIPT, "x-conifer-counterfactual-nanousd": "900000" }),
      respond({}, RECEIPT), // no counterfactual on this one
    ]),
  });
  await collector.fetch("u", { method: "POST", headers: {} });
  await collector.fetch("u", { method: "POST", headers: {} });

  const total = collector.total;
  assert.equal(total.turns, 2);
  assert.equal(total.counterfactualTurns, 1, "the subset size must be visible");
  assert.equal(total.counterfactualNanoUsd, 900_000);
});

test("the total stays exact even after the retention cap drops receipts", async () => {
  // A spend figure that quietly stopped counting would be worse than none.
  const collector = new ReceiptCollector({
    retain: 2,
    fetch: stub([respond({}), respond({}), respond({}), respond({})]),
  });
  for (let i = 0; i < 4; i += 1) await collector.fetch("u", { method: "POST", headers: {} });

  assert.equal(collector.all.length, 2, "the retained tail is bounded");
  assert.equal(collector.total.turns, 4, "but the count is of every turn");
  assert.equal(collector.total.costNanoUsd, 4 * 580_000);
});

test("a throwing callback cannot break the request or corrupt the total", async () => {
  // The caller already paid for that turn. Their bad metrics hook must not
  // turn a successful, billed inference call into a failure.
  const collector = new ReceiptCollector({
    fetch: stub([respond({ ok: true })]),
    onReceipt: () => {
      throw new Error("the caller's metrics backend is down");
    },
  });
  const response = await collector.fetch("u", { method: "POST", headers: {} });
  assert.equal(response.status, 200);
  assert.equal(collector.total.costNanoUsd, 580_000);
});

test("`fetch` survives being torn off the instance", async () => {
  // `fetch: receipts.fetch` is exactly how these clients take it, so a plain
  // method would lose `this` and fail at the first call.
  const collector = new ReceiptCollector({ fetch: stub([respond({})]) });
  const torn = collector.fetch;
  await torn("u", { method: "POST", headers: {} });
  assert.equal(collector.total.turns, 1);
});

test("reset clears the retained tail AND the total", async () => {
  const collector = new ReceiptCollector({ fetch: stub([respond({})]) });
  await collector.fetch("u", { method: "POST", headers: {} });
  collector.reset();
  assert.equal(collector.all.length, 0);
  assert.equal(collector.total.turns, 0);
  assert.equal(collector.total.costNanoUsd, 0);
});

test("a spend budget refuses the NEXT call once it is spent", async () => {
  const budget = new SpendBudget(1_000_000, { fetch: stub([respond({}), respond({})]) });
  assert.equal(budget.remainingNanoUsd, 1_000_000);

  // One 580000 turn: under budget, so a second call is still allowed.
  await budget.fetch("u", { method: "POST", headers: {} });
  assert.equal(budget.spentNanoUsd, 580_000);
  assert.equal(budget.remainingNanoUsd, 420_000);
  assert.equal(budget.exhausted, false);

  // The second turn crosses the line. It is NOT refused — the cost is only
  // known once it settles, which is why the worst case is budget + one turn.
  await budget.fetch("u", { method: "POST", headers: {} });
  assert.equal(budget.exhausted, true);
  assert.equal(budget.remainingNanoUsd, 0, "remaining is clamped, never negative");

  // The THIRD is refused, client-side, before any request is made.
  await assert.rejects(
    () => budget.fetch("u", { method: "POST", headers: {} }),
    (error: unknown) => {
      assert.match((error as Error).message, /budget exhausted/);
      // The message must say the refusal was ours, or a reader will hunt for
      // a gateway 402 that never happened.
      assert.match((error as Error).message, /CLIENT-SIDE/);
      return true;
    },
  );
});

test("a fractional or negative budget is refused rather than rounded", () => {
  assert.throws(() => new SpendBudget(1.5), /INTEGER/);
  assert.throws(() => new SpendBudget(-1), /INTEGER|negative/);
});
