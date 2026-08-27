// tests/deferred.test.ts — the deferred-job plane, with an injected fetch.
//
// WHY THIS FILE EXISTS. The SDK accepted `defer: true` on `chat()` from the
// start, and had no way to collect the result. Worse than missing: the gateway
// answers a deferred submit with 202 and a JOB ENVELOPE, which `chat()` coerced
// into `Completion` — so a turn that had been accepted AND DEBITED came back as
// `choices: []` with `textOf() === undefined`, indistinguishable at the call
// site from a model that answered with nothing. The money was spent and the job
// id was reachable only by digging through the untyped spread.
//
// Every status string and shape below was observed against api.conifer.build on
// 2026-08-27, including a full round trip: queued -> submitted -> ended ->
// (fetch) -> fetched, settling at 470000 nanodollars.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Conifer,
  ConiferConflictError,
  ConiferPortabilityError,
  ConiferTimeoutError,
  MIN_DEFER_WINDOW_SECONDS,
  TERMINAL_JOB_STATUSES,
  isTerminalJob,
  textOf,
  toDeferredJob,
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

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** The exact 202 envelope the live gateway returned. */
const ACCEPTED = {
  job_id: "job-gw-abc",
  status: "queued",
  deadline_utc: 1787900264,
  poll_url: "/v1/deferred/job-gw-abc",
};

const client = (fetchImpl: any) => new Conifer({ apiKey: "k", fetch: fetchImpl });

test("chat() refuses a deferred turn instead of returning an empty completion", async () => {
  // The regression this whole file exists for. A 202 is not a completion, and
  // pretending otherwise spends money and returns nothing readable.
  const { calls, fetchImpl } = stubFetch([]);
  await assert.rejects(
    () =>
      client(fetchImpl).chat({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        defer: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConiferPortabilityError);
      assert.equal(error.field, "defer");
      // The message must name the way forward, not just the problem.
      assert.match(error.message, /defer\(\)/);
      return true;
    },
  );
  // Refused before the request: no money moved to produce this error.
  assert.equal(calls.length, 0);
});

test("defer() submits with the gateway's 24h floor and returns the job", async () => {
  const { calls, fetchImpl } = stubFetch([jsonResponse(ACCEPTED, { status: 202 })]);
  const job = await client(fetchImpl).defer({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });

  const body = JSON.parse(calls[0]!.init.body);
  assert.equal(body.defer, "allow");
  // The gateway REFUSES a narrower window ("defer requires a completion window
  // of at least 86400 seconds"), so defaulting to the floor is what makes the
  // common call work rather than 400.
  assert.equal(body.completion_window_seconds, MIN_DEFER_WINDOW_SECONDS);
  assert.equal(calls[0]!.init.headers["x-conifer-defer"], "allow");

  assert.equal(job.jobId, "job-gw-abc");
  assert.equal(job.status, "queued");
  assert.equal(job.deadlineUtc, 1787900264);
});

test("an explicit deadline is honored rather than overwritten by the floor", async () => {
  const { calls, fetchImpl } = stubFetch([jsonResponse(ACCEPTED, { status: 202 })]);
  await client(fetchImpl).defer({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    deadlineSeconds: 172_800,
  });
  assert.equal(JSON.parse(calls[0]!.init.body).completion_window_seconds, 172_800);
});

test("a fallback chain cannot ride a deferred job", async () => {
  // The outcome is not known for hours, by which time "fall back" would mean
  // submitting a second job the caller never asked for.
  const { calls, fetchImpl } = stubFetch([]);
  await assert.rejects(
    () =>
      client(fetchImpl).defer({
        model: "m",
        messages: [],
        fallbackModels: ["b"],
        allowClientFallback: true,
      }),
    ConiferPortabilityError,
  );
  assert.equal(calls.length, 0);
});

test("status, result and cancel hit the paths the gateway publishes", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ job_id: "job-gw-abc", status: "submitted", model: "claude-fable-5" }),
    jsonResponse(
      {
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: "pinecone" } }],
        usage: { prompt_tokens: 17, completion_tokens: 6 },
      },
      { headers: { "x-conifer-cost-nanousd": "470000" } },
    ),
    jsonResponse({ job_id: "job-gw-abc", status: "cancelled" }),
  ]);
  const conifer = client(fetchImpl);

  const status = await conifer.jobs.status("job-gw-abc");
  assert.match(calls[0]!.url, /\/v1\/deferred\/job-gw-abc$/);
  assert.equal(status.status, "submitted");
  assert.equal(status.model, "claude-fable-5");

  const answer = await conifer.jobs.result("job-gw-abc");
  assert.match(calls[1]!.url, /\/v1\/deferred\/job-gw-abc\/result$/);
  assert.equal(textOf(answer), "pinecone");
  // A deferred result settles in band, exactly like a non-streamed turn.
  assert.equal(answer.receipt.costNanoUsd, 470_000);

  const cancelled = await conifer.jobs.cancel("job-gw-abc");
  assert.match(calls[2]!.url, /\/v1\/deferred\/job-gw-abc\/cancel$/);
  assert.equal(calls[2]!.init.method, "POST");
  assert.equal(cancelled.status, "cancelled");
});

test("a job id is escaped, so it cannot walk out of its own path", () => {
  // A job id is server-supplied, but it lands in a URL either way; treating it
  // as opaque text rather than a path fragment is the cheap correct habit.
  const { calls, fetchImpl } = stubFetch([jsonResponse({ job_id: "x", status: "queued" })]);
  return client(fetchImpl)
    .jobs.status("../../v1/balance")
    .then(() => {
      assert.match(calls[0]!.url, /%2E%2E%2F|\.\.%2F/);
      assert.doesNotMatch(calls[0]!.url, /\/v1\/balance$/);
    });
});

test("wait() polls to the end and returns the settled result", async () => {
  const { calls, fetchImpl } = stubFetch([
    jsonResponse({ job_id: "j", status: "queued" }),
    jsonResponse({ job_id: "j", status: "submitted" }),
    jsonResponse({ job_id: "j", status: "ended" }),
    jsonResponse(
      { choices: [{ message: { role: "assistant", content: "pinecone" } }] },
      { headers: { "x-conifer-cost-nanousd": "470000" } },
    ),
  ]);
  const seen: string[] = [];
  const answer = await client(fetchImpl).jobs.wait("j", {
    pollMs: 1,
    onPoll: (job) => seen.push(String(job.status)),
  });
  // The live sequence, condensed: queued -> submitted -> ended -> fetch.
  assert.deepEqual(seen, ["queued", "submitted", "ended"]);
  assert.equal(textOf(answer), "pinecone");
  assert.equal(answer.receipt.costNanoUsd, 470_000);
  assert.equal(calls.length, 4);
});

test("wait() stops on a terminal state instead of polling forever", async () => {
  // The loop-that-cannot-exit bug, prevented by construction. `cancelled`,
  // `failed` and `expired` never change, so a poll loop keyed only on "is it
  // ended yet" would spin until the process died.
  for (const status of ["cancelled", "failed", "expired"]) {
    const { calls, fetchImpl } = stubFetch([jsonResponse({ job_id: "j", status })]);
    await assert.rejects(
      () => client(fetchImpl).jobs.wait("j", { pollMs: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ConiferConflictError, `${status} should be a conflict`);
        assert.match(error.message, new RegExp(status));
        return true;
      },
    );
    // Exactly one poll: it learned the answer and stopped.
    assert.equal(calls.length, 1, `${status} must not be polled twice`);
  }
});

test("wait() honors a timeout WITHOUT cancelling the caller's paid work", async () => {
  // `timeoutMs: 0` expires as soon as the first poll comes back, which keeps
  // the test deterministic: one scripted response, no race between the poll
  // backoff and a wall clock.
  const { calls, fetchImpl } = stubFetch([jsonResponse({ job_id: "j", status: "queued" })]);
  await assert.rejects(
    () => client(fetchImpl).jobs.wait("j", { pollMs: 1, timeoutMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ConiferTimeoutError, `got ${(error as Error).constructor.name}`);
      // The message must say the job survived, or a reader will assume the
      // opposite and re-submit work they have already paid for.
      assert.match(error.message, /NOT cancelled/);
      return true;
    },
  );
  // No cancel was issued. Killing paid work on a client-side clock is not a
  // decision this SDK makes for you.
  assert.equal(calls.length, 1);
  assert.equal(calls.every((call) => !call.url.endsWith("/cancel")), true);
});

test("the terminal set matches the gateway's own state machine", () => {
  // `ended` is deliberately NOT terminal here: it is the state where a result
  // becomes fetchable, and treating it as an end would skip collecting it.
  assert.deepEqual([...TERMINAL_JOB_STATUSES], ["fetched", "expired", "cancelled", "failed"]);
  assert.equal(isTerminalJob("ended"), false);
  assert.equal(isTerminalJob("queued"), false);
  assert.equal(isTerminalJob("submitted"), false);
  assert.equal(isTerminalJob("fetched"), true);
  assert.equal(isTerminalJob(undefined), false);
});

test("the job envelope parses without losing what the gateway sent", () => {
  const job = toDeferredJob({ ...ACCEPTED, surprise_field: 1 });
  assert.equal(job.jobId, "job-gw-abc");
  assert.equal(job.pollUrl, "/v1/deferred/job-gw-abc");
  // Nothing the gateway said is dropped behind our field names.
  assert.equal((job.raw as any).surprise_field, 1);
});
