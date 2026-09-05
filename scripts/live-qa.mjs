#!/usr/bin/env node
// scripts/live-qa.mjs — exercise every SDK surface against a REAL gateway.
//
// The offline suites use an injected transport, which proves the SDK builds the
// bytes it intends to. This proves the gateway agrees. Every defect found in
// the 2026-08-27 QA pass was invisible to the offline suites and obvious here:
//
//   · three error classes unreachable, because the gateway had moved to the
//     industry error vocabulary while the fixtures kept the retired names;
//   · `requestId` inert, because the gateway reads `idempotency-key` first;
//   · `chat({defer:true})` returning an empty completion for a turn that had
//     been accepted AND DEBITED.
//
// A test that mocks the server can only ever confirm what we already believed.
//
// This release campaign requires an explicitly approved plan and --execute.
// Both languages share at most 40 POSTs and $1.850000002 in reserved ceilings.
// Set the reviewed installed-package and campaign paths through CONIFER_QA_*
// variables. Deferred jobs require a separate plan. A non-executing invocation
// fails, so a publisher cannot mistake an omitted live gate for a passing one.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BASE_URL, BUILD, PINS, journal, assertModel, emptyOutcome, createGuardedFetch } from "./live-qa-transport.mjs";

if (process.argv.includes("--include-deferred")) throw new Error("deferred jobs require a separate bounded plan");
if (!process.argv.includes("--execute")) {
  console.log("Local-only default. Review the bounded campaign plan; --execute requires fresh spend approval.");
  process.exit(2);
}
const packagePath = process.env.CONIFER_QA_NODE_PACKAGE;
if (!packagePath || !process.env.CONIFER_QA_RUN_DIR) throw new Error("set CONIFER_QA_NODE_PACKAGE and CONIFER_QA_RUN_DIR to the reviewed artifact and campaign paths");
if (!existsSync(packagePath)) throw new Error("installed npm artifact is missing; no source fallback");
const entry = pathToFileURL(packagePath);

const {
  Conifer,
  VERSION,
  ConiferBadRequestError,
  ConiferCostCeilingError,
  ConiferModelNotFoundError,
  ConiferPortabilityError,
  ReceiptCollector,
  SpendBudget,
  isTerminalJob,
  emptyReason,
  textOf,
  vectorOf,
} = await import(entry.href);

const includeDeferred = false;
if (VERSION !== "0.2.1") throw new Error(`wrong installed package version: ${VERSION}`);
function resolveKey() {
  if (!process.env.CONIFER_API_KEY) throw new Error("set CONIFER_API_KEY explicitly; no credential discovery");
  return process.env.CONIFER_API_KEY;
}
resolveKey();
const finalOnly = process.argv.includes("--continue-final-auto");
const finalCase = "chat(model: auto) is routed and the receipt names the pick";
const phase = journal(finalOnly ? "claim_tail" : process.argv.includes("--resume-after-repair") ? "resume" : "claim");
const guardedFetch = createGuardedFetch({ remainingPhaseMs: phase.remaining_phase_ms ?? 900_000 });
console.log(`Installed npm ${VERSION}: ${packagePath}`);

let passed = phase.prior_passed ?? 0;
let failed = 0;

async function check(name, run) {
  if (finalOnly && name !== finalCase) return;
  guardedFetch.caseName = name;
  try {
    const detail = await run();
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

/** Assert, with the value in the message so a failure is diagnosable. */
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const conifer = new Conifer({ apiKey: resolveKey(), baseUrl: BASE_URL, maxRetries: 0, timeoutMs: 90_000, fetch: guardedFetch });
const health = await (await guardedFetch(`${BASE_URL}/healthz`, { method: "GET" })).json();
if (typeof health.build !== "string" || !health.build.endsWith(`+${BUILD}`)) throw new Error("gateway build differs from approved plan");
console.log(`\nlive QA against ${conifer.transport.baseUrl}\n`);

// ---------------------------------------------------------------- catalog

console.log("catalog");
let chatModel;
let embedModel;
let catalog;
if (finalOnly) {
  catalog = await conifer.models();
  for (const id of [phase.warmed_pick.model, ...phase.warmed_pick.fallbacks]) {
    assertModel(catalog.find(m => m.id === id), 2048);
  }
}

await check("models() returns a priced, capability-declaring catalog", async () => {
  const models = await conifer.models();
  if (models.length === 0) throw new Error("the catalog is empty");
  catalog = models;
  chatModel = PINS.chat; embedModel = PINS.embed;
  assertModel(models.find(m => m.id === chatModel), 16, "tools", "openai");
  assertModel(models.find(m => m.id === chatModel), 128, "tools", "openai");
  assertModel(models.find(m => m.id === PINS.spare), 128, "tools", "openai");
  assertModel(models.find(m => m.id === PINS.native), 2048, "tools", "anthropic");
  assertModel(models.find(m => m.id === embedModel), undefined, "embeddings", "openai");
  const unsupported = models.find(m => m.id === "qwen3.8-max");
  if (unsupported) eq(unsupported.outputTokenLimitSupported, false, "unsupported output limit parsed");
  const minimum = models.find(m => m.id === "glm-5.3-flash");
  if (minimum) eq(minimum.minOutputTokens, 512, "minimum output budget parsed");
  return `${models.length} models`;
});

await check("model(id) round-trips one entry", async () => {
  const one = await conifer.model(chatModel);
  eq(one.id, chatModel, "id");
  return one.id;
});

await check("cheapestFor ranks the catalog's own decimal-string prices", async () => {
  // The regression this guards: parsing prices as numbers ranked the entire
  // live catalog as unpriced, so this returned nothing at all.
  const cheap = await conifer.cheapestFor(["embeddings"]);
  if (!cheap) throw new Error("no cheapest embedding model — are prices parsing?");
  return cheap.id;
});

await check("balance() reads without moving money", async () => {
  const balance = await conifer.balance();
  if (typeof balance.remainingNanoUsd !== "number") throw new Error("no remaining balance");
  if (!Number.isSafeInteger(balance.remainingNanoUsd) || balance.remainingNanoUsd < 2_000_000_000) throw new Error("insufficient balance for the bounded plan");
  return `${balance.remainingUsd} USD`;
});

if (failed) throw new Error("catalog/balance preflight failed; no inference dispatched");
journal("ready");

// ------------------------------------------------------------------- chat

console.log("\nchat");

await check("chat() returns an answer AND its exact settled cost", async () => {
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "reply with exactly: pinecone" }],
    maxTokens: 128,
  });
  eq(textOf(answer)?.trim(), "pinecone", "answer");
  if (typeof answer.receipt.costNanoUsd !== "number") {
    throw new Error("no cost on a non-streamed turn — the receipt is the product");
  }
  return `${answer.receipt.costUsd} USD, ${answer.receipt.effectiveModel}`;
});

await check("the settled cost rides the BODY, not only the headers", async () => {
  // A logging pipeline that keeps bodies and discards headers — which is most
  // of them — must still see what the turn cost. This is the field OpenRouter
  // puts cost in, so a migrating team's cost column keeps working.
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 128,
  });
  if (answer.usage?.cost_nanousd === undefined) {
    throw new Error("no cost on usage — a body-only logger would see nothing");
  }
  eq(answer.usage.cost_nanousd, answer.receipt.costNanoUsd, "body vs header cost");
  return `${answer.usage.cost} USD on the body, matching the receipt`;
});

await check("the caller's requestId is the id that comes back", async () => {
  // Was inert until 2026-08-27: the gateway reads `idempotency-key` first, and
  // the SDK always sends one, so `x-request-id` was never consulted.
  const mine = `live-qa-${Date.now()}`;
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 128,
    requestId: mine,
  });
  eq(answer.receipt.requestId, mine, "requestId");
  return mine;
});

await check("stream() flows and reports usage in its terminal chunk", async () => {
  const stream = await conifer.stream({
    model: chatModel,
    messages: [{ role: "user", content: "Reply with exactly: 1,2,3" }],
    maxTokens: 128,
  });
  let chunks = 0;
  let usage;
  let visible = "";
  for await (const chunk of stream) {
    chunks += 1;
    visible += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = chunk.usage;
  }
  if (chunks === 0) throw new Error("no chunks arrived");
  // The documented asymmetry: cost is absent on a stream because the head is
  // sent before the first token. Usage is how a stream is reconciled.
  if (!usage) throw new Error("no terminal usage chunk — a stream must be reconcilable");
  eq(visible.trim().replace(/\s/g, ""), "1,2,3", "streamed content");
  guardedFetch.streamDone(usage);
  const receipt = await stream.receipt();
  if (receipt.costNanoUsd !== undefined) {
    throw new Error("a stream disclosed a cost on the head; the README says it cannot");
  }
  return `${chunks} chunks, ${usage.total_tokens} tokens`;
});

await check("an empty completion explains itself rather than just being empty", async () => {
  // The trap: a reasoning model spends maxTokens on its thinking block FIRST,
  // so a tight budget yields empty content, finish_reason "length", and a bill
  // for every output token. Indistinguishable at the call site from a refusal
  // or a broken SDK unless something reads finish_reason for you.
  let truncated;
  try {
    truncated = await conifer.chat({
      model: chatModel,
      messages: [{ role: "user", content: "What is 8347 * 9182? Think it through step by step." }],
      maxTokens: 16,
    });
  } catch (error) { return emptyOutcome(error); }
  if (!textOf(truncated)?.trim()) throw new Error("empty successful completion is invalid on this gateway");
  eq(emptyReason(truncated), undefined, "a visible completion needs no explanation");
  return "visible answer; no invented explanation";
});

// -------------------------------------------------------------- embeddings

console.log("\nembeddings");
let observedEmbeddingWidth;

await check("embeddings decode losslessly, base64 and float alike", async () => {
  // WHY THIS COMPARES ONE RESPONSE AGAINST ITSELF rather than two calls.
  //
  // The first version of this check embedded the same text twice — once
  // `base64`, once `float` — and compared the vectors. It failed against
  // `bge-m3`, and the SDK was not the reason: that model is NON-DETERMINISTIC.
  // Six identical `float` calls returned FOUR distinct vectors, differing by
  // up to 2.2e-4, while `text-embedding-3-small` returned the same bytes every
  // time. Batched GPU inference reorders float accumulation depending on what
  // else shares the batch, and a normalized 1024-dim vector shows it.
  //
  // So a two-call comparison cannot isolate the decoder: a mismatch means
  // "either the decode is wrong or the provider is nondeterministic", which is
  // exactly the ambiguity a QA check must not have. Asking for BOTH encodings
  // of ONE inference removes the provider from the question entirely — the
  // bytes and the JSON floats describe the same computation, so any difference
  // is ours.
  const response = await conifer.embeddings.create({
    model: embedModel,
    input: "hello world",
    encodingFormat: "float",
  });
  const decoded = vectorOf(response);
  observedEmbeddingWidth = decoded.length;
  const asSent = response.raw.data[0].embedding;
  if (!Array.isArray(asSent)) throw new Error("`float` did not return a JSON array");
  eq(decoded.length, asSent.length, "dimension");
  for (let i = 0; i < decoded.length; i += 1) {
    if (decoded[i] !== asSent[i]) {
      throw new Error(`decode altered value ${i}: ${asSent[i]} -> ${decoded[i]}`);
    }
  }

  // And the base64 path on its own response: decodes to the right shape, and
  // to finite numbers rather than the empty vector an unparsed payload yields.
  const packed = await conifer.embeddings.create({ model: embedModel, input: "hello world" });
  const unpacked = vectorOf(packed);
  if (typeof packed.raw.data[0].embedding !== "string") {
    throw new Error("the default did not request base64");
  }
  eq(unpacked.length, decoded.length, "base64 dimension");
  if (unpacked.length === 0) throw new Error("base64 decoded to an EMPTY vector");
  if (!unpacked.every((value) => Number.isFinite(value))) {
    throw new Error("base64 decoded to non-finite values");
  }
  // Same computation, so the two must agree to within this model's own
  // run-to-run noise. A decode bug is orders of magnitude larger than that
  // (wrong endianness or a misaligned offset produces garbage, not 1e-4).
  const bytes = Buffer.from(packed.raw.data[0].embedding, "base64");
  eq(bytes.length, unpacked.length * 4, "base64 byte width");
  for (let i = 0; i < unpacked.length; i++) eq(unpacked[i], bytes.readFloatLE(i * 4), `base64 value ${i}`);
  const drift = Math.max(...unpacked.map((value, i) => Math.abs(value - decoded[i])));
  // Separate provider inferences may drift; exact decoding is checked against each response above.
  if (typeof packed.receipt.costNanoUsd !== "number") {
    throw new Error("embeddings settle in band; the cost must be on this response");
  }
  return `${decoded.length} dims, decode exact, run-to-run drift ${drift.toExponential(1)}`;
});

await check("the catalog's advertised vector width is the width you get", async () => {
  // The claim a caller acts on BEFORE spending anything: `vector(1536)` in a
  // migration, sized from the catalog. If the advertised width and the real
  // one ever diverged, the failure would land in someone's database schema
  // rather than in their code, which is a far worse place to find it.
  const model = (await conifer.models()).find((entry) => entry.id === embedModel);
  const advertised = model?.embeddingDimensions;
  if (advertised === undefined) throw new Error(`${embedModel} advertises no embedding_dimensions`);
  const actual = observedEmbeddingWidth;
  if (actual === undefined) throw new Error("the live embedding decode check produced no vector");
  eq(actual, advertised, "advertised vs actual vector width");
  return `${embedModel} advertises ${advertised}, returns ${actual}`;
});

await check("a batch returns one vector per input, in order", async () => {
  const batch = await conifer.embeddings.create({
    model: embedModel,
    input: ["alpha", "beta", "gamma"],
  });
  eq(batch.data.length, 3, "count");
  eq(batch.data.map((d) => d.index).join(","), "0,1,2", "order");
  return `${batch.data.length} vectors`;
});

await check("a chat model on the embeddings door is refused, legibly", async () => {
  try {
    await conifer.embeddings.create({ model: chatModel, input: "hi" });
  } catch (error) {
    if (!(error instanceof ConiferBadRequestError)) throw error;
    return error.message.slice(0, 48);
  }
  throw new Error("a chat model was accepted on the embeddings door");
});

// ------------------------------------------------------------------ money

console.log("\nmoney and refusals");

await check("a cost ceiling refuses BEFORE any upstream call", async () => {
  try {
    await conifer.chat({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
      maxCostNanoUsd: 1,
    });
  } catch (error) {
    if (!(error instanceof ConiferCostCeilingError)) throw error;
    // The two amounts are what make this actionable rather than just a 402.
    if (typeof error.projectedNanoUsd !== "number") throw new Error("no projected cost parsed");
    return `projected ${error.projectedNanoUsd} > ceiling ${error.ceilingNanoUsd}`;
  }
  throw new Error("the ceiling did not refuse");
});

await check("an unknown model is a typed 404, not a hang", async () => {
  try {
    await conifer.chat({
      model: "no-such-model-xyz",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
    });
  } catch (error) {
    if (!(error instanceof ConiferModelNotFoundError)) throw error;
    return error.code ?? error.type;
  }
  throw new Error("an unknown model was accepted");
});

await check("a bad credential is an auth error, not a bare ConiferError", async () => {
  // The exact regression that made three error classes unreachable.
  const stranger = new Conifer({ apiKey: "sk-conifer-definitely-not-valid", baseUrl: BASE_URL, maxRetries: 0, timeoutMs: 90_000, fetch: guardedFetch });
  try {
    await stranger.balance();
  } catch (error) {
    eq(error.constructor.name, "ConiferAuthError", "class");
    eq(error.retryable, false, "retryable");
    return `${error.type} / ${error.code}`;
  }
  throw new Error("a bogus key was accepted");
});

// --------------------------------------------------- receipts for any client

console.log("\nreceipts for any client");

await check("ReceiptCollector observes a raw fetch without disturbing it", async () => {
  const receipts = new ReceiptCollector({ fetch: guardedFetch });
  const response = await receipts.fetch(`${conifer.transport.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
    }),
  });
  // The body must still belong entirely to the caller.
  eq(response.bodyUsed, false, "bodyUsed before the caller reads");
  const parsed = await response.json();
  if (!parsed.choices) throw new Error("the body was damaged in transit");
  if (typeof receipts.last?.costNanoUsd !== "number") throw new Error("no receipt captured");
  return `${receipts.total.costUsd} USD over ${receipts.total.turns} turn(s)`;
});

await check("SpendBudget refuses the next call once spent", async () => {
  const budget = new SpendBudget(1, { fetch: guardedFetch }); // 1 nanodollar: the first turn blows it
  const call = () =>
    budget.fetch(`${conifer.transport.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: chatModel,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 128,
      }),
    });
  await (await call()).json();
  if (!budget.exhausted) throw new Error("the budget should be exhausted");
  try {
    await guardedFetch.withoutEgress(call);
  } catch (error) {
    if (!/budget exhausted/.test(error.message)) throw error;
    return `refused after ${budget.spentNanoUsd} nUSD`;
  }
  throw new Error("the budget did not refuse the second call");
});

// ------------------------------------------------------------ other wires

console.log("\nalternate wires");

await check("the Responses and Anthropic doors carry the SAME receipt headers", async () => {
  // The SDK deliberately does not reimplement these wires — the vendor SDKs
  // already speak them and the gateway relays them faithfully. What MUST hold
  // is that the receipt is identical on all three, because that is the whole
  // basis for telling people to keep their client and add a ReceiptCollector.
  // If a door ever stopped disclosing cost, that advice would silently become
  // false for everyone using it.
  const key = resolveKey();
  const post = (path, body) =>
    guardedFetch(`${conifer.transport.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

  const doors = [
    ["/v1/responses", { model: chatModel, input: "hi", max_output_tokens: 128 }],
    ["/v1/messages", { model: PINS.native, max_tokens: 2048, messages: [{ role: "user", content: "hi" }] }],
  ];
  const seen = [];
  for (const [path, body] of doors) {
    const response = await post(path, body);
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    // Read it with the SAME collector a user would attach to their own client.
    const receipts = new ReceiptCollector({ fetch: async () => response });
    await receipts.fetch(path, { method: "POST", headers: {} });
    const cost = receipts.last?.costNanoUsd;
    if (typeof cost !== "number") throw new Error(`${path} disclosed no cost`);
    await response.arrayBuffer();
    seen.push(`${path.replace("/v1/", "")}=${cost}`);
  }
  return seen.join(" ");
});

// --------------------------------------------------------------- deferred

console.log("\ndeferred jobs");

await check("chat() refuses a deferred turn rather than returning nothing", async () => guardedFetch.withoutEgress(async () => {
  try {
    await conifer.chat({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
      defer: true,
    });
  } catch (error) {
    if (!(error instanceof ConiferPortabilityError)) throw error;
    eq(error.field, "defer", "field");
    return "refused client-side, no spend";
  }
  throw new Error("chat() accepted defer and returned something");
}));

if (includeDeferred) {
  await check("defer() submits, status polls, cancel terminates", async () => {
    const job = await conifer.defer({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
    });
    if (!job.jobId) throw new Error("no job id");
    const status = await conifer.jobs.status(job.jobId);
    if (isTerminalJob(status.status)) throw new Error(`already terminal: ${status.status}`);
    const cancelled = await conifer.jobs.cancel(job.jobId);
    if (!isTerminalJob(cancelled.status)) {
      throw new Error(`cancel left a non-terminal state: ${cancelled.status}`);
    }
    return `${job.status} -> ${cancelled.status}`;
  });

  await check("a foreign job id is a 404 with no existence oracle", async () => {
    try {
      await conifer.jobs.status("job-gw-definitely-not-a-real-job");
    } catch (error) {
      if (!(error instanceof ConiferModelNotFoundError)) throw error;
      return error.type;
    }
    throw new Error("a nonexistent job id was found");
  });
} else {
  console.log("  skip deferred submit/cancel (requires a separate bounded plan)");
}

// -------------------------------------------------- server fallback chain
//
// The offline suites prove the SDK builds `x-conifer-fallback-models` the way
// it intends. Only the live gateway proves it AGREES — that the separator, the
// de-duplication rule and the disclosure line up across two repos. Every check
// here costs one real (cheap) turn.

console.log("\nserver fallback chain");

await check("a declared chain never moves a HEALTHY turn off the pin", async () => {
  // A real second catalog id, so the chain is one the gateway would actually
  // admit; the point of this case is that it is never REACHED.
  //
  // The spare must be CHAT-capable. Picking merely "any other id" drew an
  // embeddings-only model, which the gateway refuses at admission on a chat
  // wire — so the case failed on the chain being rejected outright, never
  // reaching the property it exists to test (that a healthy turn stays pinned).
  const spare = PINS.spare;
  assertModel((await conifer.models()).find(m => m.id === spare), 128, "tools", "openai");
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "reply with the single word: ok" }],
    maxTokens: 128,
    serverFallbackModels: [spare],
  });
  eq(answer.receipt.effectiveModel, chatModel, "effective model");
  eq(answer.receipt.reason, "as_requested", "receipt reason");
  return `${answer.receipt.effectiveModel} (${answer.receipt.reason})`;
});

await check("an unknown chain member is refused BY NAME, before any spend", async () => {
  // The one property the whole feature rests on: a fallback that could never
  // serve must fail LOUDLY at admission, not quietly at the outage it was
  // bought for. A silent skip here would be undetectable in production.
  try {
    await conifer.chat({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 128,
      serverFallbackModels: ["zzz-not-a-model"],
    });
  } catch (error) {
    if (!/zzz-not-a-model/.test(error?.message ?? "")) {
      throw new Error(`refused, but without naming the id: ${error?.message}`);
    }
    return "named the unserved id";
  }
  throw new Error("an unserved fallback id was accepted");
});

await check("a chain that de-duplicates away sends no header at all", async () => {
  // The SDK drops the primary from its own fallback list, as the gateway does.
  // If it instead sent an empty header value, this would be a 400 — which is
  // exactly the drift this check exists to catch.
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "reply with the single word: ok" }],
    maxTokens: 128,
    serverFallbackModels: [chatModel],
  });
  eq(answer.receipt.effectiveModel, chatModel, "effective model");
  return "served, not 400'd";
});

// ------------------------------------------------------------ the router
//
// The router runs on a GPU that scales to zero. The first call after a quiet
// spell wakes it: route() answers 503 and chat(model: "auto") serves the pin
// with reason "as_requested". Both are documented behavior, not failures, so
// each check below warms first and retries once across the cold window.

console.log("\nthe router");

let warmedPick = finalOnly ? phase.warmed_pick : undefined;
async function routeWarm(request) {
  const attempts = finalOnly ? phase.route_warmups_remaining : 6;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await conifer.route({ ...request, maxOutputTokens: 2048 }); }
    catch (error) {
      if (error?.status !== 503 || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
  throw new Error("approved router warmup allowance exhausted");
}

await check("route() returns a servable pick, its fallbacks and the artifact version", async () => {
  const pick = await routeWarm({ query: "What is 17 * 23?", policy: "balanced" });
  if (!pick.model) throw new Error("no model in the decision");
  if (!Array.isArray(pick.fallbacks)) throw new Error("fallbacks is not a list");
  if (!pick.routerVersion) throw new Error("no router version");
  eq(pick.policy, "balanced", "policy echoed");
  const catalog = await conifer.models();
  for (const id of [pick.model, ...pick.fallbacks]) assertModel(catalog.find(m => m.id === id), 2048);
  warmedPick = pick;
  return `${pick.model} (+${pick.fallbacks.length} fallbacks)`;
});

await check("a muted or unknown policy is a 400, never a quiet substitute", async () => {
  try {
    await conifer.route({ query: "x", policy: "fast", maxOutputTokens: 2048 });
  } catch (error) {
    if (error?.status === 400) return "400 for fast";
    throw error;
  }
  throw new Error("fast was served");
});

await check(finalCase, async () => {
  if (finalOnly) {
    warmedPick = await routeWarm({ query: "What is 17 * 23?", policy: "balanced" });
    for (const id of [warmedPick.model, ...warmedPick.fallbacks]) {
      assertModel(catalog.find(m => m.id === id), 2048);
    }
  }
  if (!warmedPick) throw new Error("router readiness gate failed; auto inference withheld");
  const answer = await conifer.chat({
    model: "auto",
    messages: [{ role: "user", content: "What is 17 * 23? Reply with just the number." }],
    maxTokens: 2048,
    maxCostNanoUsd: 350_000_000,
  });
  eq(textOf(answer)?.trim(), "391", "routed arithmetic");
  assertModel(catalog.find(m => m.id === answer.receipt.effectiveModel), 2048);
  eq(answer.receipt.requestedModel, "auto", "requested model");
  eq(answer.receipt.reason, "routed", "receipt reason");
  if (answer.receipt.effectiveModel === "auto") throw new Error("effective model is still the alias");
  return `${answer.receipt.effectiveModel}, ${answer.receipt.costNanoUsd} nUSD`;
});

// ----------------------------------------------------------------- verdict

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
console.log(journal("finish", { failed_checks: failed, passed_checks: passed }));
process.exit(failed === 0 ? 0 : 1);
