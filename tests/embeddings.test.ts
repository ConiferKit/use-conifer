// tests/embeddings.test.ts — the embeddings door, exercised through its public
// seam with an injected fetch. No network: every assertion is about bytes we
// would put on the wire or values we would hand back.
//
// The fixtures here are not invented. The base64 payload and the receipt below
// are the bytes `text-embedding-3-small` actually returned from
// api.conifer.build on 2026-08-27, so the decode assertions check real provider
// output rather than a vector we round-tripped through our own encoder.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Conifer,
  ConiferPortabilityError,
  decodeVector,
  embeddingsBody,
  embeddingsHeaders,
  toCatalogModel,
  vectorOf,
} from "../src/index.ts";

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

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const RECEIPT = {
  "x-conifer-requested-model": "text-embedding-3-small",
  "x-conifer-effective-model": "text-embedding-3-small",
  "x-conifer-cost-nanousd": "40",
  "x-conifer-request-id": "gw-emb-1",
};

/**
 * Three little-endian float32s, base64-encoded: [1, -2, 0.5].
 * Checked by hand so the expectation does not depend on our own encoder.
 */
const THREE_FLOATS = "AACAPwAAAMAAAAA/";

const client = (fetchImpl: any) =>
  new Conifer({ apiKey: "k", fetch: fetchImpl, baseUrl: "https://api.conifer.build" });

test("an embeddings turn hits the embeddings door and returns its settled cost", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse(
      {
        object: "list",
        model: "text-embedding-3-small",
        data: [{ object: "embedding", index: 0, embedding: THREE_FLOATS }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      },
      RECEIPT,
    ),
  ]);
  const result = await client(fetchImpl).embeddings.create({
    model: "text-embedding-3-small",
    input: "hello world",
  });

  assert.equal(calls[0]?.url, "https://api.conifer.build/v1/embeddings");
  assert.equal(calls[0]?.init.method, "POST");
  // Embeddings settle IN BAND — unlike a stream, the cost is on this response.
  assert.equal(result.receipt.costNanoUsd, 40);
  assert.equal(result.receipt.costUsd, "0.000000040");
  assert.equal(result.receipt.requestId, "gw-emb-1");
  // Input tokens only: there is no completion, so no completion_tokens.
  assert.equal(result.usage?.prompt_tokens, 2);
  assert.equal(result.usage?.completion_tokens, undefined);
});

test("base64 is requested by default and decoded into plain numbers", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ data: [{ index: 0, embedding: THREE_FLOATS }] }, RECEIPT),
  ]);
  const result = await client(fetchImpl).embeddings.create({
    model: "text-embedding-3-small",
    input: "hello world",
  });

  // The wire asked for base64 (3x smaller than a JSON float array) …
  assert.equal(JSON.parse(calls[0]!.init.body).encoding_format, "base64");
  // … and the caller never has to know that.
  assert.deepEqual(vectorOf(result), [1, -2, 0.5]);
  // The provider's own body survives untouched, base64 included, so a caller
  // who wants the raw bytes is not forced to re-request them.
  assert.equal((result.raw.data as any[])[0].embedding, THREE_FLOATS);
});

test("`float` is honored when the caller explicitly asks for it", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ data: [{ index: 0, embedding: [1, -2, 0.5] }] }, RECEIPT),
  ]);
  const result = await client(fetchImpl).embeddings.create({
    model: "text-embedding-3-small",
    input: "hello world",
    encodingFormat: "float",
  });
  assert.equal(JSON.parse(calls[0]!.init.body).encoding_format, "float");
  // Same numbers either way. This is the property that makes the base64
  // default safe to apply silently.
  assert.deepEqual(vectorOf(result), [1, -2, 0.5]);
});

test("a batch keeps one vector per input, in the order sent", async () => {
  const { fetchImpl } = stubFetch([
    jsonResponse(
      {
        data: [
          { index: 0, embedding: THREE_FLOATS },
          { index: 1, embedding: THREE_FLOATS },
          { index: 2, embedding: THREE_FLOATS },
        ],
      },
      RECEIPT,
    ),
  ]);
  const result = await client(fetchImpl).embeddings.create({
    model: "text-embedding-3-small",
    input: ["alpha", "beta", "gamma"],
  });
  assert.equal(result.data.length, 3);
  assert.deepEqual(result.data.map((entry) => entry.index), [0, 1, 2]);
  for (const entry of result.data) assert.deepEqual(entry.embedding, [1, -2, 0.5]);
});

test("token-id input is refused at the call site, before any spend", async () => {
  // The gateway refuses this too, but only AFTER admission. Catching the shape
  // here makes the reason legible and costs the caller nothing.
  const { calls, fetchImpl } = stubFetch([]);
  await assert.rejects(
    () =>
      client(fetchImpl).embeddings.create({
        model: "text-embedding-3-small",
        input: [[1, 2, 3]] as unknown as string[],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConiferPortabilityError);
      assert.equal(error.field, "input");
      return true;
    },
  );
  // The point of refusing client-side: no request was made at all.
  assert.equal(calls.length, 0);
});

test("the money ceiling and attribution ride as headers, exactly as on chat", () => {
  const headers = embeddingsHeaders(
    {
      model: "text-embedding-3-small",
      input: "hi",
      maxCostNanoUsd: 1_000_000,
      client: "my-app",
      requestId: "req-1",
    },
    "idem-1",
  );
  assert.equal(headers["x-conifer-max-cost-nanousd"], "1000000");
  assert.equal(headers["x-conifer-client"], "my-app");
  assert.equal(headers["x-request-id"], "req-1");
  // Every POST is idempotent, so a transport retry cannot bill twice.
  assert.equal(headers["idempotency-key"], "idem-1");
});

test("a fractional cost ceiling is refused rather than rounded", () => {
  // Rounding a spend limit is wrong in one direction half the time.
  assert.throws(
    () => embeddingsHeaders({ model: "m", input: "hi", maxCostNanoUsd: 1.5 }, "idem-1"),
    ConiferPortabilityError,
  );
});

test("the body carries only fields this door actually has", () => {
  const body = embeddingsBody({
    model: "text-embedding-3-large",
    input: "hi",
    dimensions: 256,
    user: "user-1",
  });
  // No max_tokens, no temperature, no stream: an embedding has no completion,
  // so those knobs would imply a control the wire does not have. Checked
  // BEFORE the deepEqual below, because `assert.deepEqual` is a TypeScript
  // assertion signature: it narrows `body` to the literal shape it was
  // compared against, after which indexing it by a loop variable no longer
  // typechecks.
  for (const absent of ["max_tokens", "temperature", "top_p", "stream", "messages"]) {
    assert.equal(body[absent], undefined, `${absent} must not appear on the embeddings body`);
  }
  assert.deepEqual(body, {
    model: "text-embedding-3-large",
    input: "hi",
    encoding_format: "base64",
    dimensions: 256,
    user: "user-1",
  });
});

test("decodeVector refuses to guess at a shape it does not recognize", () => {
  // A WRONG vector is far worse than a missing one: it sails through a cosine
  // similarity and returns nonsense rankings forever, with nothing to catch it.
  assert.deepEqual(decodeVector("!!!not base64!!!"), []);
  assert.deepEqual(decodeVector(null), []);
  assert.deepEqual(decodeVector(undefined), []);
  assert.deepEqual(decodeVector(42), []);
  // A truncated payload is not a vector either: float32 comes in 4-byte units.
  assert.deepEqual(decodeVector("AAA="), []);
  // And the shapes it DOES recognize still work.
  assert.deepEqual(decodeVector(THREE_FLOATS), [1, -2, 0.5]);
  assert.deepEqual(decodeVector([1, 2, 3]), [1, 2, 3]);
});

test("decoding is little-endian regardless of the host's own byte order", () => {
  // Stated explicitly rather than inherited, so this decodes identically on a
  // big-endian machine. 0x0000803F little-endian is 1.0; big-endian it is not.
  assert.deepEqual(decodeVector("AACAPw=="), [1]);
});

/**
 * Cross-language parity on the one payload whose numbers ARE the product.
 *
 * These are the first 12 bytes (3 float32s) of the vector
 * `text-embedding-3-small` returned for "hello world" from api.conifer.build on
 * 2026-08-27, copied off the wire rather than hand-assembled. The Python twin
 * asserts the SAME bytes decode to the SAME three values, so "one SDK, two
 * languages" is checked rather than claimed. A team that embeds in Python and
 * queries from TypeScript needs exactly this to hold, and a silent divergence
 * would surface only as slightly wrong search results.
 */
test("both languages decode the same live bytes to the same vector", () => {
  // Rounded to 9 DECIMAL PLACES, which is what Python's `round(x, 9)` does in
  // the twin. (`toPrecision(9)` counts significant digits instead, and would
  // compare two different roundings while looking like the same assertion.)
  const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
  assert.deepEqual(decodeVector("AKDeuwCAIL0AwAs9").map(round9), [
    -0.006793976, -0.03918457, 0.034118652,
  ]);
});

test("an empty vector list is handled without inventing a vector", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ data: [] }, RECEIPT)]);
  const result = await client(fetchImpl).embeddings.create({ model: "m", input: "hi" });
  assert.deepEqual(result.data, []);
  assert.equal(vectorOf(result), undefined);
});

/**
 * The catalog's vector width is a DDL decision, so it is typed.
 *
 * A pgvector column is declared `vector(1536)` BEFORE the first call, and
 * getting it wrong means a migration on a populated table. The catalog
 * publishes `embedding_dimensions` precisely so you can size the column without
 * spending a token — and `llms.txt` tells agents to do exactly that — so the
 * SDK should not be the one place it is reachable only through untyped `raw`.
 */
test("an embedding seat's vector width is a typed field, not a raw lookup", () => {
  const model = toCatalogModel({
    id: "text-embedding-3-small",
    caps: ["embeddings"],
    embedding_dimensions: 1536,
  });
  assert.equal(model.embeddingDimensions, 1536);
  // And nothing the catalog sent is lost behind the typed name.
  assert.equal(model.raw.embedding_dimensions, 1536);
});

test("a chat seat simply has no vector width, rather than a zero", () => {
  // Absent means "not an embedding model", which is a different statement from
  // "an embedding model of width 0" — and a 0 would size a column to nothing.
  const chat = toCatalogModel({ id: "claude-fable-5", caps: ["tools"] });
  assert.equal(chat.embeddingDimensions, undefined);
});
