// tests/keepalive.test.ts — the response keepalive. A non-streaming answer the
// gateway is still working on at 285 s is committed as a provisional 200 with
// `x-conifer-keepalive: committed`; whitespace heartbeats follow, then the
// door's JSON with `conifer_receipt: {status, headers}` appended last. An
// uncharged failure after the commit is aborted before the body ends; a
// charged one ends normally with its real status in `conifer_receipt.status`.

import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";

import {
  Conifer,
  ConiferConnectionError,
  ConiferError,
  ConiferUpstreamError,
  DEFAULT_TIMEOUT_MS,
  textOf,
} from "../src/index.ts";

const COMPLETION = {
  id: "chatcmpl-1",
  model: "gpt-6-astra",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pinecone" } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

const SETTLED = {
  "x-conifer-requested-model": "auto",
  "x-conifer-effective-model": "gpt-6-astra",
  "x-conifer-receipt-reason": "routed",
  "x-conifer-endpoint": "credits",
  "x-conifer-cost-nanousd": "4200000",
  "x-conifer-cost-components-nanousd": "fresh=4000000,cache_write=0,cache_read=0,output=200000",
  "x-conifer-pricing-identity": `sha256:${"ab".repeat(32)}`,
  "x-conifer-receipt-venue": "cloud",
};

/** The head the gateway commits: everything a caller can know at 285 s. */
const COMMITTED_HEAD = {
  "content-type": "application/json",
  "x-conifer-keepalive": "committed",
  "cache-control": "no-transform",
  "x-conifer-request-id": "gw-slow",
};

/** The committed body: heartbeat whitespace, then the door's JSON with its receipt appended last. */
function committedBody(door: Record<string, unknown>, status: number, headers: Record<string, string>): string {
  return `   ${JSON.stringify({ ...door, conifer_receipt: { status, headers } })}`;
}

function committed(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: COMMITTED_HEAD });
}

/** A body that sends its heartbeats and part of the error envelope, then fails: the aborted delivery. */
function cutBody(): ReadableStream<Uint8Array> {
  const pieces = ["  ", ' {"error":{"type":"upstream_error","message":"provider timed out"}'];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.shift();
      if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
      else controller.error(new TypeError("terminated"));
    },
  });
}

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

function client(fetchImpl: any, options: Record<string, unknown> = {}) {
  return new Conifer({ apiKey: "sk-conifer-test", fetch: fetchImpl, maxRetries: 0, ...options });
}

test("a committed success reads its receipt from the body and returns the door's body without it", async () => {
  const { fetchImpl } = stubFetch([committed(committedBody(COMPLETION, 200, SETTLED))]);
  const answer = await client(fetchImpl).chat({ model: "auto", messages: [] });

  assert.equal(textOf(answer), "pinecone");
  assert.equal(answer.receipt.costNanoUsd, 4_200_000);
  assert.equal(answer.receipt.effectiveModel, "gpt-6-astra");
  assert.equal(answer.receipt.pricingIdentity, `sha256:${"ab".repeat(32)}`);
  assert.deepEqual(answer.receipt.costComponentsNanoUsd, { fresh: 4_000_000, cacheWrite: 0, cacheRead: 0, output: 200_000 });
  // The request id is written by the outer layer, so it stays a real header.
  assert.equal(answer.receipt.requestId, "gw-slow");
  assert.equal(answer.usage?.cost_nanousd, 4_200_000);
  assert.equal("conifer_receipt" in answer, false, "conifer_receipt is transport framing, not the caller's data");
});

test("a committed embeddings answer settles the same way", async () => {
  const door = { object: "list", model: "text-embedding-3-small", data: [{ index: 0, embedding: [0.5, 0.25] }] };
  const { fetchImpl } = stubFetch([committed(committedBody(door, 200, SETTLED))]);
  const response = await client(fetchImpl).embeddings.create({
    model: "text-embedding-3-small",
    input: "hi",
    encodingFormat: "float",
  });
  assert.deepEqual(response.data[0]?.embedding, [0.5, 0.25]);
  assert.equal(response.receipt.costNanoUsd, 4_200_000);
  assert.equal("conifer_receipt" in response.raw, false);
});

test("a charged error after the commit raises its real class with its receipt, and is never retried", async () => {
  const door = {
    error: {
      type: "upstream_error",
      message: "the answer could not be re-rendered",
    },
  };
  const { calls, fetchImpl } = stubFetch([
    committed(committedBody(door, 502, SETTLED)),
    committed(committedBody(COMPLETION, 200, SETTLED)),
  ]);
  await assert.rejects(
    client(fetchImpl, { maxRetries: 2 }).chat({
      model: "auto",
      messages: [],
      fallbackModels: ["claude-haiku-4-5"],
      allowClientFallback: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConiferUpstreamError, `got ${(error as Error).constructor.name}`);
      assert.equal(error.status, 502);
      assert.equal(error.requestId, "gw-slow");
      assert.equal(error.receipt?.costNanoUsd, 4_200_000);
      assert.equal(error.retryable, false, "a charged error re-sent is charged again");
      return true;
    },
  );
  assert.equal(calls.length, 1, "neither the transport nor the fallback chain may re-send a charged error");
});

test("a charged output-budget error after the commit carries what it cost", async () => {
  const door = {
    error: {
      type: "output_budget_exhausted",
      param: "max_tokens",
      message: "The model exhausted the output budget before producing an answer. Usage for this attempt was settled; no automatic retry was made.",
    },
  };
  const { calls, fetchImpl } = stubFetch([committed(committedBody(door, 422, SETTLED))]);
  await assert.rejects(client(fetchImpl, { maxRetries: 2 }).chat({ model: "auto", messages: [] }), (error: unknown) => {
    assert.ok(error instanceof ConiferError);
    assert.equal(error.status, 422);
    assert.equal(error.type, "output_budget_exhausted");
    assert.equal(error.receipt?.costUsd, "0.004200000");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a committed response cut mid-body is a retryable connection error, retried under the same key", async () => {
  const { calls, fetchImpl } = stubFetch([
    committed(cutBody()),
    committed(committedBody(COMPLETION, 200, SETTLED)),
  ]);
  const answer = await client(fetchImpl, { maxRetries: 1 }).chat({ model: "auto", messages: [] });
  assert.equal(textOf(answer), "pinecone");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init.headers["idempotency-key"], calls[1]!.init.headers["idempotency-key"]);

  const { fetchImpl: once } = stubFetch([committed(cutBody())]);
  await assert.rejects(client(once).chat({ model: "auto", messages: [] }), (error: unknown) => {
    assert.ok(error instanceof ConiferConnectionError, `got ${(error as Error).constructor.name}`);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a committed body that ends without its receipt was cut, not answered", async () => {
  for (const body of ["   ", '  {"id":"chatcmpl-1","choices":[]', JSON.stringify(COMPLETION)]) {
    const { fetchImpl } = stubFetch([committed(body)]);
    await assert.rejects(
      client(fetchImpl).chat({ model: "auto", messages: [] }),
      ConiferConnectionError,
      `a committed body of ${JSON.stringify(body)} must not read as an answer`,
    );
  }
});

test("an uncommitted error is unchanged: no receipt, so it stays retryable", async () => {
  const { calls, fetchImpl } = stubFetch([
    new Response(JSON.stringify({ error: { type: "service_unavailable", message: "down" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify(COMPLETION), { status: 200, headers: { "content-type": "application/json", ...SETTLED } }),
  ]);
  const answer = await client(fetchImpl, { maxRetries: 1 }).chat({ model: "m", messages: [] });
  assert.equal(calls.length, 2);
  assert.equal(answer.receipt.costNanoUsd, 4_200_000);
});

test("an error that answers with the execution receipt was charged, committed or not", async () => {
  const { calls, fetchImpl } = stubFetch([
    new Response(JSON.stringify({ error: { type: "upstream_error", message: "re-render failed" } }), {
      status: 502,
      headers: { "content-type": "application/json", ...SETTLED },
    }),
  ]);
  await assert.rejects(client(fetchImpl, { maxRetries: 2 }).chat({ model: "m", messages: [] }), (error: unknown) => {
    assert.ok(error instanceof ConiferUpstreamError);
    assert.equal(error.retryable, false);
    assert.equal(error.receipt?.effectiveModel, "gpt-6-astra");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("the headers timeout outlasts the 285 s commit, and the heartbeat body is not under it", async () => {
  // The gateway commits at 285 s so that the head beats every 300 s cut,
  // including this client's own. Scaled 1000x: head at 285 ms, timeout 300 ms,
  // the answer at 600 ms.
  assert.ok(DEFAULT_TIMEOUT_MS > 285_000, "the client must not quit before the gateway commits");
  const encoder = new TextEncoder();
  const fetchImpl = async (_url: string, init: { signal?: AbortSignal }) => {
    await new Promise((resolve) => setTimeout(resolve, 285));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(" "));
        await new Promise((resolve) => setTimeout(resolve, 315));
        assert.equal(init.signal?.aborted, false, "the headers timeout fired after the head arrived");
        controller.enqueue(encoder.encode(committedBody(COMPLETION, 200, SETTLED)));
        controller.close();
      },
    });
    return committed(body);
  };
  const answer = await client(fetchImpl, { timeoutMs: 300 }).chat({ model: "auto", messages: [] });
  assert.equal(textOf(answer), "pinecone");
  assert.equal(answer.receipt.costNanoUsd, 4_200_000);
});

// ---------------------------------------------------------------------------
// The same deliveries over a real socket and the runtime's own fetch, so the
// abort is the one a real connection produces, not a stub's.

function serve(handlers: Array<(socket: Socket) => void>): Promise<{ server: Server; url: string; served: () => number }> {
  let served = 0;
  const server = createServer((socket) => {
    socket.once("data", () => {
      const handler = handlers[served] ?? handlers[handlers.length - 1]!;
      served += 1;
      handler(socket);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}`, served: () => served });
    });
  });
}

function chunk(text: string): string {
  return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}

const HEAD =
  "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-conifer-keepalive: committed\r\n" +
  "cache-control: no-transform\r\nx-conifer-request-id: gw-socket\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";

test("over a real socket, an aborted committed failure is retried and the answer settles", async () => {
  const { server, url, served } = await serve([
    (socket) => {
      socket.write(HEAD + chunk(" ") + chunk(" "));
      const door = { error: { type: "upstream_error", message: "provider timed out" } };
      socket.write(chunk(JSON.stringify({ ...door, conifer_receipt: { status: 503, headers: {} } })));
      // No terminating chunk: the gateway aborts an uncharged failure.
      setTimeout(() => socket.destroy(), 20);
    },
    (socket) => {
      socket.write(HEAD + chunk(" "));
      socket.end(chunk(committedBody(COMPLETION, 200, SETTLED)) + "0\r\n\r\n");
    },
  ]);
  try {
    const answer = await new Conifer({ apiKey: "k", baseUrl: url, maxRetries: 1 }).chat({ model: "auto", messages: [] });
    assert.equal(textOf(answer), "pinecone");
    assert.equal(answer.receipt.costNanoUsd, 4_200_000);
    assert.equal(answer.receipt.requestId, "gw-socket");
    assert.equal(served(), 2);
  } finally {
    server.close();
  }
});

test("over a real socket, an aborted committed failure with no retries left is a connection error", async () => {
  const { server, url } = await serve([
    (socket) => {
      socket.write(HEAD + chunk(" ") + chunk('{"error":{"type":"upstream_error","message":"provider timed out"}'));
      setTimeout(() => socket.destroy(), 20);
    },
  ]);
  try {
    await assert.rejects(
      new Conifer({ apiKey: "k", baseUrl: url, maxRetries: 0 }).chat({ model: "auto", messages: [] }),
      ConiferConnectionError,
    );
  } finally {
    server.close();
  }
});
