// tests/client.test.ts — the client, exercised through its public seam with an
// injected fetch. No network, no mocks of our own internals: every assertion is
// about bytes we would put on the wire or values we would hand back.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Conifer,
  ConiferCostCeilingError,
  ConiferModelNotFoundError,
  ConiferPaymentError,
  ConiferPortabilityError,
  ConiferRateLimitError,
  chatBody,
  chatHeaders,
  nanoUsdToUsdString,
  parseCostComponents,
  parseFrame,
  pickCheapest,
  priceOf,
  readReceipt,
  resolveBaseUrl,
  resolveChain,
  textOf,
} from "../src/index.ts";

/** Record every call and answer from a scripted queue. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response left");
    return next;
  };
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const RECEIPT_HEADERS = {
  "x-conifer-requested-model": "anthropic/claude-haiku-4-5",
  "x-conifer-effective-model": "claude-haiku-4-5",
  "x-conifer-receipt-reason": "requested",
  "x-conifer-endpoint": "conifer",
  "x-conifer-cost-nanousd": "1250000",
  "x-conifer-cost-components-nanousd": "fresh=1000000,cache_write=0,cache_read=50000,output=200000",
  "x-conifer-request-id": "req-abc",
};

const COMPLETION = {
  id: "chatcmpl-1",
  model: "claude-haiku-4-5",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pinecone" } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

function client(fetchImpl: any, options: Record<string, unknown> = {}) {
  return new Conifer({ apiKey: "sk-conifer-test", fetch: fetchImpl, maxRetries: 0, ...options });
}

test("a chat turn sends the OpenAI wire and returns the parsed receipt", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS }),
  ]);
  const completion = await client(fetchImpl).chat({
    model: "anthropic/claude-haiku-4-5",
    messages: [{ role: "user", content: "three names for a build cache" }],
    maxTokens: 64,
  });

  const call = calls[0]!;
  assert.equal(call.url, "https://api.conifer.build/v1/chat/completions");
  assert.equal(call.init.headers.authorization, "Bearer sk-conifer-test");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "anthropic/claude-haiku-4-5");
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, undefined);

  assert.equal(textOf(completion), "pinecone");
  assert.equal(completion.fallbackIndex, 0);
  assert.equal(completion.receipt.costNanoUsd, 1_250_000);
  assert.equal(completion.receipt.costUsd, "0.001250000");
  assert.equal(completion.receipt.effectiveModel, "claude-haiku-4-5");
  assert.equal(completion.receipt.requestId, "req-abc");
});

test("every POST carries an idempotency key, so a retry cannot double-bill", async () => {
  const { calls, fetchImpl } = stubFetch([jsonResponse(COMPLETION)]);
  await client(fetchImpl).chat({ model: "m", messages: [] });
  assert.match(calls[0]!.init.headers["idempotency-key"], /^idem-/);
});

test("a transport retry reuses the SAME idempotency key", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ error: { type: "service_unavailable", message: "down" } }, { status: 503 }),
    jsonResponse(COMPLETION),
  ]);
  await client(fetchImpl, { maxRetries: 1 }).chat({ model: "m", messages: [] });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.init.headers["idempotency-key"],
    calls[1]!.init.headers["idempotency-key"],
  );
});

test("a 402 that names a ceiling is a different class from a 402 that names a balance", async () => {
  const ceiling = stubFetch([
    jsonResponse(
      {
        error: {
          type: "cost_ceiling_exceeded",
          message:
            "projected worst-case cost 5000000 nanodollars exceeds the x-conifer-max-cost-nanousd ceiling 1000000; refused before any upstream call",
        },
      },
      { status: 402 },
    ),
  ]);
  const ceilingError = await client(ceiling.fetchImpl)
    .chat({ model: "m", messages: [], maxCostNanoUsd: 1_000_000 })
    .catch((error) => error);
  assert.ok(ceilingError instanceof ConiferCostCeilingError);
  assert.equal(ceilingError.projectedNanoUsd, 5_000_000);
  assert.equal(ceilingError.ceilingNanoUsd, 1_000_000);
  assert.equal(ceilingError.retryable, false);

  const balance = stubFetch([
    jsonResponse(
      {
        error: {
          type: "insufficient_allowance",
          message: "insufficient allowance: this request needs up to 900 nanodollars but you hold 100; add credits",
        },
      },
      { status: 402 },
    ),
  ]);
  const paymentError = await client(balance.fetchImpl)
    .chat({ model: "m", messages: [] })
    .catch((error) => error);
  assert.ok(paymentError instanceof ConiferPaymentError);
  assert.equal(paymentError.requiredNanoUsd, 900);
  assert.equal(paymentError.balanceNanoUsd, 100);
});

test("a 429 carries the gateway's own retry-after", async () => {
  const { fetchImpl } = stubFetch([
    jsonResponse({ error: { type: "rate_limited", message: "slow down" } }, {
      status: 429,
      headers: { "retry-after": "7" },
    }),
  ]);
  const error = await client(fetchImpl).chat({ model: "m", messages: [] }).catch((e) => e);
  assert.ok(error instanceof ConiferRateLimitError);
  assert.equal(error.retryAfterSeconds, 7);
  assert.equal(error.retryable, true);
});

test("a 4xx the gateway authored is never retried", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ error: { type: "invalid_request", message: "bad" } }, { status: 400 }),
  ]);
  await assert.rejects(() => client(fetchImpl, { maxRetries: 3 }).chat({ model: "m", messages: [] }));
  assert.equal(calls.length, 1, "a 400 must not be retried");
});

test("model_not_found does not advance a fallback chain", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ error: { type: "model_not_found", message: "no" } }, { status: 404 }),
  ]);
  const error = await client(fetchImpl)
    .chat({
      model: "missing",
      messages: [],
      fallbackModels: ["other"],
      allowClientFallback: true,
    })
    .catch((e) => e);
  assert.ok(error instanceof ConiferModelNotFoundError);
  assert.equal(calls.length, 1, "a non-retryable refusal is the same on every member");
});

test("a retryable failure advances the chain and reports which member served", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ error: { type: "service_unavailable", message: "down" } }, { status: 503 }),
    jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS }),
  ]);
  const completion = await client(fetchImpl).chat({
    model: "primary",
    messages: [],
    fallbackModels: ["backup"],
    allowClientFallback: true,
  });
  assert.equal(completion.fallbackIndex, 1);
  assert.equal(JSON.parse(calls[0]!.init.body).model, "primary");
  assert.equal(JSON.parse(calls[1]!.init.body).model, "backup");
  assert.notEqual(
    calls[0]!.init.headers["idempotency-key"],
    calls[1]!.init.headers["idempotency-key"],
    "a different body needs a different key, or the gateway refuses the replay",
  );
});

test("a fallback list without the explicit opt-in refuses", () => {
  assert.throws(
    () => resolveChain({ model: "a", messages: [], fallbackModels: ["b"] }),
    ConiferPortabilityError,
  );
  assert.deepEqual(
    resolveChain({ model: "a", messages: [], fallbackModels: ["b"], allowClientFallback: true }),
    ["a", "b"],
  );
});

test("a stream always asks for the terminal usage chunk", () => {
  const body = chatBody({ model: "m", messages: [] }, true);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("a fallback chain cannot be attached to a stream", async () => {
  const { fetchImpl } = stubFetch([]);
  await assert.rejects(
    () =>
      client(fetchImpl).stream({
        model: "m",
        messages: [],
        fallbackModels: ["b"],
        allowClientFallback: true,
      }),
    ConiferPortabilityError,
  );
});

test("streaming yields chunks and resolves the receipt after the loop", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"pine"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"cone"}}]}\n\n' +
    "data: [DONE]\n\n";
  const { fetchImpl } = stubFetch([
    new Response(sse, { status: 200, headers: { ...RECEIPT_HEADERS, "content-type": "text/event-stream" } }),
  ]);
  const stream = await client(fetchImpl).stream({ model: "m", messages: [] });
  const text: string[] = [];
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta as { content?: string } | undefined;
    if (delta?.content !== undefined) text.push(delta.content);
  }
  assert.equal(text.join(""), "pinecone");
  const receipt = await stream.receipt();
  assert.equal(receipt.costNanoUsd, 1_250_000);
});

test("hard constraints ride as headers; advisory ones ride as both", () => {
  const headers = chatHeaders(
    {
      model: "m",
      messages: [],
      maxCostNanoUsd: 5_000_000,
      deadlineSeconds: 600,
      defer: true,
      venue: "cloud",
      promptCache: "off",
      client: "slack-bot",
    },
    "idem-1",
  );
  assert.equal(headers["x-conifer-max-cost-nanousd"], "5000000");
  assert.equal(headers["x-conifer-deadline"], "600");
  assert.equal(headers["x-conifer-defer"], "allow");
  assert.equal(headers["x-conifer-venue"], "cloud");
  assert.equal(headers["x-conifer-cache"], "off");
  assert.equal(headers["x-conifer-client"], "slack-bot");

  const body = chatBody({ model: "m", messages: [], deadlineSeconds: 600, defer: true }, false);
  assert.equal(body.completion_window_seconds, 600);
  assert.equal(body.defer, "allow");
});

test("a fractional cost ceiling is refused, not rounded", () => {
  assert.throws(
    () => chatHeaders({ model: "m", messages: [], maxCostNanoUsd: 1.5 }, "idem"),
    ConiferPortabilityError,
  );
});

test("the catalog keeps every field, and absence stays absence", async () => {
  const { fetchImpl } = stubFetch([
    jsonResponse({
      object: "list",
      data: [
        {
          id: "claude-haiku-4-5",
          endpoint_kind: "conifer",
          provider: "anthropic",
          context_window: 200000,
          caps: ["tools", "vision"],
          pricing: { input: 1, output: 5 },
        },
        { id: "bare-model", endpoint_kind: "byok", fee_pct: 4.5 },
      ],
    }),
  ]);
  const models = await client(fetchImpl).models();
  assert.equal(models[0]!.contextWindow, 200000);
  assert.deepEqual(models[0]!.caps, ["tools", "vision"]);
  assert.equal(models[1]!.caps, undefined, "undeclared caps stay undefined, never []");
  assert.equal(models[1]!.feePct, 4.5);
  assert.equal(models[0]!.raw.id, "claude-haiku-4-5");
});

test("balance converts nanodollars to an exact decimal string", async () => {
  const { fetchImpl } = stubFetch([
    jsonResponse({
      remaining_nanodollars: 12_500_000_000,
      included_nanodollars: 10_000_000_000,
      allowance_remaining_nanodollars: 2_500_000_000,
      credits_remaining_nanodollars: 10_000_000_000,
    }),
  ]);
  const balance = await client(fetchImpl).balance();
  assert.equal(balance.remainingNanoUsd, 12_500_000_000);
  assert.equal(balance.remainingUsd, "12.500000000");
});

/** The LIVE catalog's shape: prices are decimal STRINGS per million tokens. */
function priced(inUsd: string, outUsd: string) {
  return {
    in_usd_per_mtok: inUsd,
    out_usd_per_mtok: outUsd,
    cache_read_usd_per_mtok: "1",
    cache_write_usd_per_mtok: "12.5",
  };
}

test("cheapest-capable reads the catalog's decimal-STRING prices", () => {
  // Regression: an earlier version summed only numeric pricing values, so
  // against the real catalog (which states money as strings) every model
  // ranked as unpriced and cheapestFor returned nothing at all.
  const models = [
    { id: "no-caps", raw: {}, pricing: priced("1", "1") },
    { id: "capable-cheap", raw: {}, caps: ["tools"], pricing: priced("1", "5") },
    { id: "capable-dear", raw: {}, caps: ["tools"], pricing: priced("10", "50") },
    { id: "capable-unpriced", raw: {}, caps: ["tools"] },
    { id: "degraded", raw: {}, caps: ["tools"], pricing: priced("0.1", "0.1"), unavailable: true },
  ];
  assert.equal(pickCheapest(models, ["tools"])?.id, "capable-cheap");
  assert.equal(pickCheapest(models, ["tools"], { minContextWindow: 1 }), undefined);
  assert.equal(pickCheapest(models, [])?.id, "no-caps");
});

test("output rate is weighted, so cheap input cannot hide ruinous output", () => {
  const cheapInputRuinousOutput = { id: "trap", raw: {}, pricing: priced("0.5", "100") };
  const balanced = { id: "balanced", raw: {}, pricing: priced("2", "6") };
  assert.equal(pickCheapest([cheapInputRuinousOutput, balanced], [])?.id, "balanced");
});

test("an unrecognized pricing shape is unpriced, never free", () => {
  assert.equal(priceOf({ id: "x", raw: {}, pricing: { some_future_field: "3" } }), undefined);
  assert.equal(priceOf({ id: "x", raw: {} }), undefined);
  assert.equal(priceOf({ id: "x", raw: {}, pricing: priced("10", "50") }), 160);
});

test("receipt parsing preserves absence rather than zero-filling", () => {
  const headers = new Headers({ "x-conifer-cost-nanousd": "42" });
  const receipt = readReceipt(headers);
  assert.equal(receipt.costNanoUsd, 42);
  assert.equal(receipt.costComponentsNanoUsd, undefined);
  assert.equal(receipt.serviceTier, undefined, "never fabricate a tier");
});

test("a partial cost itemization is discarded, because the sum identity is the contract", () => {
  assert.equal(parseCostComponents("fresh=1,output=2"), undefined);
  const full = parseCostComponents("fresh=1,cache_write=2,cache_read=3,output=4");
  assert.deepEqual(full, { fresh: 1, cacheWrite: 2, cacheRead: 3, output: 4 });
});

test("nanodollars render exactly, with no float drift", () => {
  assert.equal(nanoUsdToUsdString(1), "0.000000001");
  assert.equal(nanoUsdToUsdString(1_000_000_000), "1.000000000");
  assert.equal(nanoUsdToUsdString(123_456_789_012), "123.456789012");
});

test("SSE frames that are not data are ignored", () => {
  assert.equal(parseFrame(": keep-alive"), undefined);
  assert.equal(parseFrame("data: [DONE]"), undefined);
  assert.equal(parseFrame(""), undefined);
  assert.deepEqual(parseFrame('data: {"id":"x"}'), { id: "x" });
});

test("a stray OPENAI_BASE_URL cannot redirect Conifer traffic elsewhere", () => {
  assert.equal(
    resolveBaseUrl(undefined, { OPENAI_BASE_URL: "https://api.openai.com/v1" }),
    "https://api.conifer.build",
  );
  assert.equal(
    resolveBaseUrl(undefined, { OPENAI_BASE_URL: "https://api.conifer.build/v1" }),
    "https://api.conifer.build",
  );
  assert.equal(
    resolveBaseUrl(undefined, { CONIFER_BASE_URL: "https://staging.conifer.build/v1/" }),
    "https://staging.conifer.build",
  );
  assert.equal(resolveBaseUrl("http://localhost:8080", {}), "http://localhost:8080");
});

test("a missing key fails at construction, not at the first call", () => {
  assert.throws(() => new Conifer({ apiKey: "", fetch: (async () => new Response("")) as any }), /CONIFER_API_KEY/);
});
