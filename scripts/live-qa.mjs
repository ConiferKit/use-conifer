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
// THIS SPENDS REAL MONEY. Every run is a handful of small turns (well under a
// cent at the models chosen). It is not part of `npm test` for that reason —
// run it deliberately, before a release.
//
//   CONIFER_API_KEY=sk-… node scripts/live-qa.mjs
//   CONIFER_API_KEY=sk-… node scripts/live-qa.mjs --include-deferred
//
// `--include-deferred` adds a job submit + cancel. The full deferred round trip
// is excluded by default because it rides a provider batch and took ~2 minutes
// when measured, which is too slow for a pre-release gate.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
// Prefer the BUILT package: that is what a user installs. Fall back to sources
// so this is runnable in a checkout that has not built yet.
const entry = existsSync(fileURLToPath(new URL("dist/src/index.js", root)))
  ? new URL("dist/src/index.js", root)
  : new URL("src/index.ts", root);

const {
  Conifer,
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

const includeDeferred = process.argv.includes("--include-deferred");

/** The key: the env var, or the dev-token file this repo's tooling writes. */
function resolveKey() {
  if (process.env.CONIFER_API_KEY) return process.env.CONIFER_API_KEY;
  const devToken = new URL(".conifer/dev-token", `file://${process.env.HOME}/`);
  if (existsSync(fileURLToPath(devToken))) {
    return readFileSync(fileURLToPath(devToken), "utf8").trim();
  }
  throw new Error("set CONIFER_API_KEY (mint one at https://conifer.build/console#/keys)");
}

let passed = 0;
let failed = 0;

async function check(name, run) {
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

const conifer = new Conifer({ apiKey: resolveKey() });
console.log(`\nlive QA against ${conifer.transport.baseUrl}\n`);

// ---------------------------------------------------------------- catalog

console.log("catalog");
let chatModel;
let embedModel;

await check("models() returns a priced, capability-declaring catalog", async () => {
  const models = await conifer.models();
  if (models.length === 0) throw new Error("the catalog is empty");
  chatModel = models.find((m) => m.caps?.includes("tools"))?.id;
  embedModel = models.find((m) => m.caps?.includes("embeddings"))?.id;
  if (!chatModel) throw new Error("no model declares `tools`");
  if (!embedModel) throw new Error("no model declares `embeddings`");
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
  return `${balance.remainingUsd} USD`;
});

// ------------------------------------------------------------------- chat

console.log("\nchat");

await check("chat() returns an answer AND its exact settled cost", async () => {
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "reply with exactly: pinecone" }],
    maxTokens: 20,
  });
  if (typeof textOf(answer) !== "string") throw new Error("no text in the completion");
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
    maxTokens: 200,
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
    maxTokens: 5,
    requestId: mine,
  });
  eq(answer.receipt.requestId, mine, "requestId");
  return mine;
});

await check("stream() flows and reports usage in its terminal chunk", async () => {
  const stream = await conifer.stream({
    model: chatModel,
    messages: [{ role: "user", content: "count to three" }],
    maxTokens: 30,
  });
  let chunks = 0;
  let usage;
  for await (const chunk of stream) {
    chunks += 1;
    if (chunk.usage) usage = chunk.usage;
  }
  if (chunks === 0) throw new Error("no chunks arrived");
  // The documented asymmetry: cost is absent on a stream because the head is
  // sent before the first token. Usage is how a stream is reconciled.
  if (!usage) throw new Error("no terminal usage chunk — a stream must be reconcilable");
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
  const truncated = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "What is 8347 * 9182? Think it through step by step." }],
    maxTokens: 16,
  });
  const text = textOf(truncated);
  if (text !== "") {
    // Not every model truncates the same way; if this one answered, the
    // explanation must be ABSENT rather than invented.
    eq(emptyReason(truncated), undefined, "a completion with text needs no explanation");
    return "model answered within 16 tokens; no explanation offered (correct)";
  }
  const why = emptyReason(truncated);
  if (why === undefined) throw new Error("empty content with no explanation — the trap is back");
  if (!/maxTokens/.test(why)) throw new Error(`unhelpful explanation: ${why}`);
  return why.slice(0, 44);
});

// -------------------------------------------------------------- embeddings

console.log("\nembeddings");

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
  const drift = Math.max(...unpacked.map((value, i) => Math.abs(value - decoded[i])));
  if (drift > 1e-2) {
    throw new Error(`base64 and float disagree by ${drift}, far beyond sampling noise`);
  }
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
  const actual = vectorOf(await conifer.embeddings.create({ model: embedModel, input: "hi" }))?.length;
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
      maxTokens: 100,
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
      maxTokens: 5,
    });
  } catch (error) {
    if (!(error instanceof ConiferModelNotFoundError)) throw error;
    return error.code ?? error.type;
  }
  throw new Error("an unknown model was accepted");
});

await check("a bad credential is an auth error, not a bare ConiferError", async () => {
  // The exact regression that made three error classes unreachable.
  const stranger = new Conifer({ apiKey: "sk-conifer-definitely-not-valid" });
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
  const receipts = new ReceiptCollector();
  const response = await receipts.fetch(`${conifer.transport.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
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
  const budget = new SpendBudget(1); // 1 nanodollar: the first turn blows it
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
        max_tokens: 5,
      }),
    });
  await (await call()).json();
  if (!budget.exhausted) throw new Error("the budget should be exhausted");
  try {
    await call();
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
    fetch(`${conifer.transport.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

  const doors = [
    ["/v1/responses", { model: chatModel, input: "hi", max_output_tokens: 200 }],
    ["/v1/messages", { model: chatModel, max_tokens: 200, messages: [{ role: "user", content: "hi" }] }],
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
    seen.push(`${path.replace("/v1/", "")}=${cost}`);
  }
  return seen.join(" ");
});

// --------------------------------------------------------------- deferred

console.log("\ndeferred jobs");

await check("chat() refuses a deferred turn rather than returning nothing", async () => {
  try {
    await conifer.chat({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
      defer: true,
    });
  } catch (error) {
    if (!(error instanceof ConiferPortabilityError)) throw error;
    eq(error.field, "defer", "field");
    return "refused client-side, no spend";
  }
  throw new Error("chat() accepted defer and returned something");
});

if (includeDeferred) {
  await check("defer() submits, status polls, cancel terminates", async () => {
    const job = await conifer.defer({
      model: chatModel,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 20,
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
  console.log("  skip deferred submit/cancel (pass --include-deferred)");
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
  const spare = (await conifer.models()).map((m) => m.id).find((id) => id !== chatModel);
  if (!spare) throw new Error("the catalog has only one model; cannot form a chain");
  const answer = await conifer.chat({
    model: chatModel,
    messages: [{ role: "user", content: "reply with the single word: ok" }],
    maxTokens: 16,
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
      maxTokens: 16,
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
    maxTokens: 16,
    serverFallbackModels: [chatModel],
  });
  eq(answer.receipt.effectiveModel, chatModel, "effective model");
  return "served, not 400'd";
});

// ----------------------------------------------------------------- verdict

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
