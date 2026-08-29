// tests/client.test.ts — the client, exercised through its public seam with an
// injected fetch. No network, no mocks of our own internals: every assertion is
// about bytes we would put on the wire or values we would hand back.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Conifer,
  ConiferCapabilityError,
  ConiferConflictError,
  ConiferCostCeilingError,
  ConiferModelNotFoundError,
  ConiferPaymentError,
  ConiferPortabilityError,
  ConiferRateLimitError,
  chatBody,
  chatHeaders,
  emptyReason,
  minimumBackoffMs,
  nanoUsdToUsdString,
  parseCostComponents,
  parseFrame,
  pickCheapest,
  priceOf,
  readReceipt,
  resolveBaseUrl,
  resolveChain,
  serverFallbackHeader,
  textOf,
  withCost,
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

/**
 * THE IMAGE-FALLBACK PATH (the 2026-08-29 OpenTag incident, closed end to
 * end): the gateway refuses an image turn on a no-vision model pre-flight
 * with `code: unsupported_parameter` / `param: messages`, the SDK maps it to
 * `ConiferCapabilityError`, and a chain with a vision member absorbs it —
 * the end user never sees an error, and nothing was billed for the refusal.
 */
test("a capability refusal advances the chain to a member that can serve it", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(
      {
        error: {
          type: "invalid_request_error",
          code: "unsupported_parameter",
          param: "messages",
          message: "this model does not support image input",
        },
      },
      { status: 400 },
    ),
    jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS }),
  ]);
  const completion = await client(fetchImpl).chat({
    model: "deepseek-v4-flash",
    messages: [],
    fallbackModels: ["glm-5.3-flash"],
    allowClientFallback: true,
  });
  assert.equal(completion.fallbackIndex, 1, "served by the vision member");
  assert.equal(JSON.parse(calls[1]!.init.body).model, "glm-5.3-flash");
});

test("a capability refusal with no chain still throws the typed class", async () => {
  const { fetchImpl } = stubFetch([
    jsonResponse(
      {
        error: {
          type: "invalid_request_error",
          code: "unsupported_parameter",
          param: "messages",
          message: "this model does not support image input",
        },
      },
      { status: 400 },
    ),
  ]);
  const error = await client(fetchImpl)
    .chat({ model: "deepseek-v4-flash", messages: [] })
    .catch((e) => e);
  assert.ok(error instanceof ConiferCapabilityError, `got ${error.constructor.name}`);
  assert.equal(error.param, "messages");
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

// ── serverFallbackModels: the GATEWAY-side chain ───────────────────────────

test("serverFallbackModels rides one header, in the caller's order", () => {
  const headers = chatHeaders(
    { model: "deepseek-v4", messages: [], serverFallbackModels: ["gpt-5.5", "claude-fable-5"] },
    "k",
  );
  assert.equal(headers["x-conifer-fallback-models"], "gpt-5.5,claude-fable-5");
});

test("a server chain is ONE request, unlike the client chain", async () => {
  // The whole point of the server chain: the gateway walks it, so the SDK
  // makes exactly one call even when a fallback ends up serving.
  const { calls, fetchImpl } = stubFetch([jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS })]);
  await client(fetchImpl).chat({
    model: "deepseek-v4",
    messages: [],
    serverFallbackModels: ["gpt-5.5"],
  });
  assert.equal(calls.length, 1, "no client-side second request");
  assert.equal(calls[0]!.init.headers["x-conifer-fallback-models"], "gpt-5.5");
  assert.equal(
    JSON.parse(calls[0]!.init.body).model,
    "deepseek-v4",
    "the body still names the model actually requested",
  );
});

test("no serverFallbackModels means no header at all", () => {
  const headers = chatHeaders({ model: "m", messages: [] }, "k");
  assert.equal(
    "x-conifer-fallback-models" in headers,
    false,
    "absent must stay absent — an empty chain is not a declared one",
  );
});

test("an unsendable server chain throws, rather than arming nothing", () => {
  // A member that cannot survive the header intact. The gateway refuses these
  // too, so throwing at the call site just moves the error somewhere useful.
  for (const [models, why] of [
    [["  "], "a blank member names no model"],
    [["a,b"], "a comma cannot survive the header's own separator"],
    [["café"], "a non-ASCII byte cannot ride a header value"],
    [["a", "b", "c", "d"], "over the gateway's 3-member cap"],
  ] as [string[], string][]) {
    assert.throws(
      () => serverFallbackHeader(models, "deepseek-v4"),
      ConiferPortabilityError,
      `${JSON.stringify(models)} — ${why}`,
    );
  }
});

test("the server chain is de-duplicated exactly as the gateway does it", () => {
  // The gateway DROPS duplicates and the primary's own id (harmless, not
  // wrong) rather than refusing. Throwing here would make the SDK stricter
  // than the wire and refuse chains the gateway would have served.
  assert.equal(serverFallbackHeader([" gpt-5.5 "], "deepseek-v4"), "gpt-5.5", "trimmed");
  assert.equal(
    serverFallbackHeader(["gpt-5.5", "gpt-5.5"], "deepseek-v4"),
    "gpt-5.5",
    "a duplicate is dropped, not refused",
  );
  assert.equal(
    serverFallbackHeader(["deepseek-v4", "gpt-5.5"], "deepseek-v4"),
    "gpt-5.5",
    "the requested model is dropped from its own fallback list",
  );
  assert.equal(
    serverFallbackHeader(["deepseek-v4"], "deepseek-v4"),
    undefined,
    "nothing survives ⇒ no header at all, never an empty one",
  );
  // The cap counts SURVIVORS, as the gateway does: four spellings of three
  // distinct models is a legal chain.
  assert.equal(
    serverFallbackHeader(["a", "b", "c", "a"], "deepseek-v4"),
    "a,b,c",
    "the cap is applied after de-duplication",
  );
});

test("a chain that de-duplicates away sends no header", async () => {
  const { calls, fetchImpl } = stubFetch([jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS })]);
  await client(fetchImpl).chat({
    model: "deepseek-v4",
    messages: [],
    serverFallbackModels: ["deepseek-v4"],
  });
  assert.equal(
    "x-conifer-fallback-models" in calls[0]!.init.headers,
    false,
    "an empty header value is a 400 at the gateway; send none instead",
  );
});

test("a server chain cannot ride a deferred job", async () => {
  const { fetchImpl } = stubFetch([]);
  await assert.rejects(
    () =>
      client(fetchImpl).defer({
        model: "m",
        messages: [],
        serverFallbackModels: ["b"],
      }),
    ConiferPortabilityError,
  );
});

test("a server chain DOES ride a stream, unlike the client chain", async () => {
  // The client chain cannot: the first token commits the turn. The gateway
  // chain can, because it fails over BEFORE the first frame — so this must
  // not inherit the client chain's refusal.
  const { calls, fetchImpl } = stubFetch([
    new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  ]);
  await client(fetchImpl).stream({
    model: "deepseek-v4",
    messages: [],
    serverFallbackModels: ["gpt-5.5"],
  });
  assert.equal(calls[0]!.init.headers["x-conifer-fallback-models"], "gpt-5.5");
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

test("a streamed receipt carries routing but NOT cost, because the wire cannot", async () => {
  // Measured live 2026-08-26: on SSE the response HEAD is sent before the
  // first token, so the gateway knows the route but not yet the money. The
  // SDK must report that absence rather than invent a zero.
  const { fetchImpl } = stubFetch([
    new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-conifer-effective-model": "claude-haiku-4-5",
        "x-conifer-endpoint": "credits",
        "x-conifer-receipt-venue": "cloud",
        "x-conifer-request-id": "gw-1",
      },
    }),
  ]);
  const stream = await client(fetchImpl).stream({ model: "m", messages: [] });
  let terminalUsage: unknown;
  for await (const chunk of stream) if (chunk.usage) terminalUsage = chunk.usage;
  const receipt = await stream.receipt();
  assert.equal(receipt.effectiveModel, "claude-haiku-4-5");
  assert.equal(receipt.receiptVenue, "cloud");
  assert.equal(receipt.costNanoUsd, undefined, "never fabricate a cost the wire did not send");
  assert.equal(receipt.costUsd, undefined);
  assert.equal(terminalUsage, undefined);
});

test("the two newer receipt headers are parsed, not dropped", () => {
  const receipt = readReceipt(
    new Headers({
      "x-conifer-receipt-venue": "cloud",
      "x-conifer-counterfactual-nanousd": "9000000",
    }),
  );
  assert.equal(receipt.receiptVenue, "cloud");
  assert.equal(receipt.counterfactualNanoUsd, 9_000_000);
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

/**
 * `requestId` used to be inert, and that is worth a test of its own.
 *
 * The gateway derives its request id from the FIRST of `idempotency-key` then
 * `x-request-id` (its own `request_id()`, confirmed live 2026-08-27). Because
 * the SDK always sends an idempotency key, the second name was never once
 * reached: a caller who set `requestId` to their trace id got a generated
 * `idem-<uuid>` back in the receipt and could not correlate a support question
 * with their own logs. On this gateway the two are ONE identity, so the SDK
 * feeds `requestId` into the key that is actually read.
 */
test("an explicit requestId becomes the id the gateway actually echoes", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(COMPLETION, { headers: { ...RECEIPT_HEADERS, "x-conifer-request-id": "trace-42" } }),
  ]);
  const conifer = new Conifer({ apiKey: "k", fetch: fetchImpl });
  const answer = await conifer.chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    requestId: "trace-42",
  });

  // The header the gateway READS carries the caller's id …
  assert.equal(calls[0]?.init.headers["idempotency-key"], "trace-42");
  // … and the one it merely logs carries it too, for anything in between.
  assert.equal(calls[0]?.init.headers["x-request-id"], "trace-42");
  // So the id the caller chose is the id that comes back.
  assert.equal(answer.receipt.requestId, "trace-42");
});

test("an explicit idempotencyKey still wins over requestId", async () => {
  // The two remain separable: idempotency is about not billing twice, and a
  // caller whose trace ids are not unique per turn must be able to say so.
  const { calls, fetchImpl } = stubFetch([jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS })]);
  await new Conifer({ apiKey: "k", fetch: fetchImpl }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    requestId: "trace-42",
    idempotencyKey: "key-1",
  });
  assert.equal(calls[0]?.init.headers["idempotency-key"], "key-1");
  assert.equal(calls[0]?.init.headers["x-request-id"], "trace-42");
});

test("with neither id, a generated key still makes the turn idempotent", async () => {
  const { calls, fetchImpl } = stubFetch([jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS })]);
  await new Conifer({ apiKey: "k", fetch: fetchImpl }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  // A retry that cannot double-bill is the whole point, so the key is never
  // optional — only its SOURCE is.
  assert.match(calls[0]?.init.headers["idempotency-key"] as string, /^idem-/);
  assert.equal(calls[0]?.init.headers["x-request-id"], undefined);
});

test("the embeddings door resolves the same identity the same way", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ data: [] }, { headers: { "x-conifer-request-id": "trace-9" } }),
  ]);
  await new Conifer({ apiKey: "k", fetch: fetchImpl }).embeddings.create({
    model: "text-embedding-3-small",
    input: "hi",
    requestId: "trace-9",
  });
  assert.equal(calls[0]?.init.headers["idempotency-key"], "trace-9");
});

/**
 * A transient 409 is retried, with the SAME key — which is what makes it safe.
 *
 * The gateway answers "this request has no replayable response; retry shortly"
 * when a key is known but its settled body lives in another replica's cache. It
 * will not guess between "settled elsewhere" and "still running", because
 * either guess can double-charge or wrongly refund. Re-asking with the same
 * idempotency key is exactly how that resolves: the gateway either replays the
 * settled response or serves the turn once.
 *
 * Found live, not by inspection: a QA run hit this on a FIRST call and the SDK
 * surfaced a hard failure for a turn the gateway was willing to serve.
 */
test("a 409 that asks to be retried IS retried, reusing the idempotency key", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(
      {
        error: {
          type: "request_in_progress",
          message: "this request has no replayable response; retry shortly",
        },
      },
      { status: 409 },
    ),
    jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS }),
  ]);
  const answer = await new Conifer({ apiKey: "k", fetch: fetchImpl }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(calls.length, 2, "the transient conflict should have been retried");
  // THE safety property: the same key both times, so the retry cannot bill a
  // second turn even if the first one had actually settled.
  assert.equal(
    calls[0]?.init.headers["idempotency-key"],
    calls[1]?.init.headers["idempotency-key"],
  );
  assert.equal(textOf(answer), "pinecone");
});

test("a 409 for a REUSED key with different bytes is not retried", async () => {
  // Terminal by construction: the same request refuses identically forever, so
  // retrying is pure latency and burnt rate limit.
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(
      {
        error: {
          type: "request_in_progress",
          message: "idempotency key was already used with a different request body",
        },
      },
      { status: 409 },
    ),
  ]);
  await assert.rejects(
    () =>
      new Conifer({ apiKey: "k", fetch: fetchImpl }).chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ConiferConflictError,
  );
  assert.equal(calls.length, 1, "a body conflict must not be retried");
});

test("a transient 409 waits long enough to actually converge", () => {
  // The default schedule (250ms, 500ms) gives a retryable failure 0.75s of
  // total patience, which is right for a 502 and far too impatient for a 409:
  // that one is waiting on CROSS-REPLICA CONVERGENCE, not on a socket. Found
  // in a fresh-install consumer test — i.e. exactly where a new user would
  // have found it, on their first call, for a turn that was being served.
  assert.ok(minimumBackoffMs(409) >= 1_000, "a 409 needs a real floor");
  // Every other status keeps the fast schedule: a blip should recover fast.
  for (const status of [429, 502, 503, 504]) {
    assert.equal(minimumBackoffMs(status), 0, `${status} must not be slowed down`);
  }
  // Two retries at the floor is several seconds of patience, which covered
  // every occurrence observed against production.
  assert.ok(minimumBackoffMs(409) * 2 >= 3_000);
});

/**
 * The empty-completion trap, and the one signal that explains it.
 *
 * Measured live 2026-08-27 on BOTH wires: a reasoning model spends `maxTokens`
 * on its thinking block FIRST, so a small budget is consumed before the visible
 * answer starts. You get `content: ""`, `finish_reason: "length"`, and a bill
 * for every one of those output tokens. `claude-fable-5` at `maxTokens: 16`
 * does exactly this; at 200 the same prompt answers fine.
 *
 * That empty string is indistinguishable, at the call site, from a refusal, a
 * content filter, or a broken SDK — and the distinguishing field is one most
 * callers never read. So the SDK reads it.
 */
test("an empty completion explains itself instead of just being empty", () => {
  const truncated = {
    choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }],
    receipt: {},
    fallbackIndex: 0,
  } as any;
  const why = emptyReason(truncated);
  assert.match(why ?? "", /maxTokens/);
  assert.match(why ?? "", /thinking block is spent FIRST/);

  // With the reasoning-token breakdown, the explanation gets specific: it can
  // name how much of the budget went to thinking rather than answering.
  const withUsage = {
    ...truncated,
    usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 20 } },
  };
  assert.match(emptyReason(withUsage) ?? "", /20 of 20 output tokens went to thinking/);
});

test("a completion that HAS text has nothing to explain", () => {
  const fine = {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "pinecone" } }],
    receipt: {},
    fallbackIndex: 0,
  } as any;
  assert.equal(emptyReason(fine), undefined);
});

test("a tool call is an answer, not an absence", () => {
  // Empty text beside a tool call is CORRECT, and calling it a failure would
  // send people chasing a bug in the one case that is working as designed.
  const toolCall = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function" }] },
      },
    ],
    receipt: {},
    fallbackIndex: 0,
  } as any;
  assert.equal(emptyReason(toolCall), undefined);
});

test("a content filter and a no-choices body are named for what they are", () => {
  const filtered = {
    choices: [{ finish_reason: "content_filter", message: { content: "" } }],
    receipt: {},
    fallbackIndex: 0,
  } as any;
  // Worth stating plainly: the filter is the PROVIDER's, not ours.
  assert.match(emptyReason(filtered) ?? "", /Conifer applies no moderation of its own/);

  // The shape a deferred 202 used to be coerced into. Point at the fix.
  const empty = { choices: [], receipt: {}, fallbackIndex: 0 } as any;
  assert.match(emptyReason(empty) ?? "", /defer\(\)/);
});

/**
 * The cost rides the BODY as well as the headers.
 *
 * OpenRouter puts the settled cost in `usage.cost`; Conifer's is on
 * `x-conifer-cost-nanousd`. Every logging pipeline, request recorder, LangChain
 * or LiteLLM callback and JSON-dumping debug line keeps the body and discards
 * the headers — so a team migrating from OpenRouter loses their cost column and
 * the fix is somewhere they are not looking.
 *
 * It matters more here than elsewhere: a normal caller cannot read their usage
 * history back (`/admin/usage/*` is owner-only), so the receipt on the turn is
 * their only record of what they spent.
 */
test("the settled cost is copied onto usage, matching the header exactly", () => {
  const usage = withCost({ prompt_tokens: 8, completion_tokens: 34 }, { costNanoUsd: 1_780_000 });
  // The integer nanodollars are the authority; `cost` is the OpenRouter-shaped
  // decimal-USD float that existing code already reads.
  assert.equal(usage?.cost_nanousd, 1_780_000);
  assert.equal(usage?.cost, 0.00178);
  // And nothing the gateway sent is disturbed.
  assert.equal(usage?.prompt_tokens, 8);
  assert.equal(usage?.completion_tokens, 34);
});

test("a turn with no disclosed cost gains no cost — 0 would mean 'free'", () => {
  // The stream case. The response head is sent before the first token, so the
  // cost headers are genuinely absent; inventing a 0 there would tell every
  // dashboard the turn was free.
  const usage = withCost({ prompt_tokens: 8 }, {});
  assert.equal(usage?.cost, undefined);
  assert.equal(usage?.cost_nanousd, undefined);
  assert.deepEqual(usage, { prompt_tokens: 8 });
  // Absent usage stays absent too, rather than becoming a cost-only object.
  assert.equal(withCost(undefined, {}), undefined);
});

test("a server-sent cost always wins over the copied one", () => {
  // Additive only. If the gateway ever puts `cost` on `usage` itself, that is
  // the authoritative number and this must not overwrite it.
  const usage = withCost({ cost: 0.42 }, { costNanoUsd: 1_780_000 });
  assert.equal(usage?.cost, 0.42);
  assert.equal(usage?.cost_nanousd, undefined, "no half-overwrite either");
});

test("a completion carries the cost in its body, not only its receipt", async () => {
  const { fetchImpl } = stubFetch([jsonResponse(COMPLETION, { headers: RECEIPT_HEADERS })]);
  const answer = await new Conifer({ apiKey: "k", fetch: fetchImpl }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  // Same number, two places: whichever half of the response a tool keeps.
  assert.equal(answer.usage?.cost_nanousd, answer.receipt.costNanoUsd);
  assert.equal(answer.usage?.cost_nanousd, 1_250_000);
});
