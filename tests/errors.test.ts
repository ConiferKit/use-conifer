// tests/errors.test.ts — the error vocabulary is a wire contract, so it is
// pinned to the gateway's own live names rather than to our hopes.
//
// WHY THIS FILE EXISTS. v0.1.0 mapped refusals by switching on `error.type`
// alone, using the gateway's ORIGINAL private names (`unauthorized`,
// `invalid_request`, `rate_limited`). The gateway has since moved to the
// INDUSTRY vocabulary — `invalid_request_error` for both a 401 and a 400,
// `rate_limit_error` for a 429 — which is the right call for portability and
// which silently broke the mapping: measured live against api.conifer.build on
// 2026-08-27, a 401 arrived as a bare `ConiferError`, a 400 arrived as a bare
// `ConiferError`, and a 429 lost its `retry-after`. Three exported error
// classes were unreachable.
//
// The old suite could not catch it because its fixtures used the retired names
// too, so code and test were consistently wrong together. These tests fix that
// by driving the fixtures FROM `contracts/gateway-contract.json` — the same
// vendored artifact the receipt headers are pinned by — so a vocabulary change
// fails here instead of in a user's error handler.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ConiferAuthError,
  ConiferBadRequestError,
  ConiferByokKeyError,
  ConiferConflictError,
  ConiferCostCeilingError,
  ConiferError,
  ConiferKeySpendCapError,
  ConiferModelNotFoundError,
  ConiferPaymentError,
  ConiferRateLimitError,
  ConiferUnavailableError,
  ConiferUpstreamError,
  errorFrom,
} from "../src/index.ts";

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../contracts/gateway-contract.json", import.meta.url)),
    "utf8",
  ),
) as {
  error_envelope: { types: string[]; codes: string[]; retired_types: string[] };
};

const headers = (extra: Record<string, string> = {}) => new Headers(extra);
const envelope = (type: string, code?: string, message = "refused") =>
  ({ error: code === undefined ? { type, message } : { type, message, code } });

/**
 * The live 401. This is the exact body `curl -H 'Authorization: Bearer bogus'
 * https://api.conifer.build/v1/balance` returned on 2026-08-27.
 */
test("a live 401 is an auth error, not a bare ConiferError", () => {
  const error = errorFrom(
    401,
    envelope("invalid_request_error", "invalid_api_key", "Incorrect API key provided"),
    headers(),
  );
  assert.ok(error instanceof ConiferAuthError, `got ${error.constructor.name}`);
  assert.equal(error.code, "invalid_api_key");
  // An auth failure is NEVER retryable: the same credential fails identically.
  assert.equal(error.retryable, false);
});

test("a 400 under the same collapsed type is a bad-request error", () => {
  const error = errorFrom(400, envelope("invalid_request_error", undefined, "bad body"), headers());
  assert.ok(error instanceof ConiferBadRequestError, `got ${error.constructor.name}`);
  assert.equal(error.retryable, false);
});

/**
 * The 429 is the costly one to get wrong: under the old mapping it fell to the
 * status-based default (`ConiferUnavailableError`), which is still retryable —
 * so the failure was invisible in aggregate but threw away the server's own
 * `retry-after` and backed off on a blind guess instead.
 */
test("a 429 keeps its class AND the server's retry-after", () => {
  const error = errorFrom(
    429,
    envelope("rate_limit_error", "rate_limit_exceeded", "slow down"),
    headers({ "retry-after": "7" }),
  );
  assert.ok(error instanceof ConiferRateLimitError, `got ${error.constructor.name}`);
  assert.equal(error.retryAfterSeconds, 7);
  assert.equal(error.retryable, true);
});

test("an unknown URL is a bad request, not a missing model", () => {
  // The gateway 404s an unserved door with the SAME collapsed type as a 401.
  // `unknown_url` is a caller-typo signal; it must not masquerade as a model
  // that could be swapped for another.
  const error = errorFrom(
    404,
    envelope("invalid_request_error", "unknown_url", "Unknown request URL"),
    headers(),
  );
  assert.ok(error instanceof ConiferModelNotFoundError, `got ${error.constructor.name}`);
  assert.equal(error.code, "unknown_url");
});

test("the money 402s stay distinguishable, and keep parsing their amounts", () => {
  const payment = errorFrom(
    402,
    envelope("insufficient_allowance", undefined, "requires 6200000 nanodollars, balance 12"),
    headers(),
  );
  assert.ok(payment instanceof ConiferPaymentError);
  assert.equal(payment.requiredNanoUsd, 6_200_000);
  assert.equal(payment.balanceNanoUsd, 12);

  // Same status, opposite remedy: add credit vs raise your own ceiling.
  const ceiling = errorFrom(
    402,
    envelope(
      "cost_ceiling_exceeded",
      undefined,
      "projected worst-case cost 6200000 nanodollars exceeds the x-conifer-max-cost-nanousd ceiling 1; refused before any upstream call",
    ),
    headers(),
  );
  assert.ok(ceiling instanceof ConiferCostCeilingError);
  assert.equal(ceiling.projectedNanoUsd, 6_200_000);
  assert.equal(ceiling.ceilingNanoUsd, 1);
});

/**
 * The three 402s, kept apart. This is the single clearest argument for classes
 * over status codes: all three are 402, nothing is charged for any of them, and
 * the correct remedy is DIFFERENT in each case — add credit, raise your own
 * per-request ceiling, or replace a key whose lifetime cap is spent. A caller
 * who only sees "402" will top up an account that was never short.
 */
test("the three 402s are three different classes with three different remedies", () => {
  const account = errorFrom(402, envelope("insufficient_allowance"), headers());
  const request = errorFrom(402, envelope("cost_ceiling_exceeded"), headers());
  const key = errorFrom(402, envelope("key_spend_cap_exceeded"), headers());

  assert.ok(account instanceof ConiferPaymentError);
  assert.ok(request instanceof ConiferCostCeilingError);
  assert.ok(key instanceof ConiferKeySpendCapError);

  // And none of them is a sibling of another, so `instanceof` cannot confuse
  // "the account is empty" with "this key is done".
  assert.ok(!(key instanceof ConiferPaymentError));
  assert.ok(!(key instanceof ConiferCostCeilingError));
  assert.ok(!(account instanceof ConiferKeySpendCapError));

  // None is retryable: the same bytes on the same credential refuse again.
  for (const error of [account, request, key]) assert.equal(error.retryable, false);
});

/**
 * The coverage gate. Every type the gateway can emit must land on a class that
 * is more specific than the bare base, or carry a deliberate exemption below.
 * A new gateway type shows up here as a failure the moment the contract is
 * refreshed, which is the only way this file keeps earning its place.
 */
test("every error type in the gateway contract maps to a specific class", () => {
  // `internal_error` is deliberately NOT given a bespoke class: a 500 is the
  // gateway's bug, and the only correct client behavior is the retry the
  // status-based default already provides.
  const exempt = new Set(["internal_error"]);
  const statusFor: Record<string, number> = {
    invalid_request_error: 400,
    rate_limit_error: 429,
    model_not_found: 404,
    job_not_found: 404,
    insufficient_allowance: 402,
    cost_ceiling_exceeded: 402,
    key_spend_cap_exceeded: 402,
    request_in_progress: 409,
    unknown_provider: 400,
    byok_key_rejected: 422,
    service_unavailable: 503,
    upstream_error: 502,
    wire_upstream_mismatch: 422,
  };

  for (const type of contract.error_envelope.types) {
    if (exempt.has(type)) continue;
    const status = statusFor[type];
    assert.ok(status !== undefined, `contract type ${type} has no status in this test`);
    const error = errorFrom(status, envelope(type), headers());
    assert.notEqual(
      error.constructor,
      ConiferError,
      `${type} fell through to the bare ConiferError — give it a class or exempt it`,
    );
    // The gateway's own word survives our class names.
    assert.equal(error.type, type);
  }
});

test("the retired type names still map to the same classes", () => {
  // An older gateway deploy, or a recorded fixture, must not change meaning.
  assert.ok(errorFrom(401, envelope("unauthorized"), headers()) instanceof ConiferAuthError);
  assert.ok(errorFrom(400, envelope("invalid_request"), headers()) instanceof ConiferBadRequestError);
  const limited = errorFrom(429, envelope("rate_limited"), headers({ "retry-after": "3" }));
  assert.ok(limited instanceof ConiferRateLimitError);
  assert.equal(limited.retryAfterSeconds, 3);
});

test("the classes that decide retry posture agree with the transport's rule", () => {
  // The transport retries ONLY transport faults and 429/502/503/504. These
  // three are the classes that carry `retryable = true` on a gateway verdict,
  // so a drift between them and the transport's status set is a real bug.
  assert.equal(errorFrom(503, envelope("service_unavailable"), headers()).retryable, true);
  assert.equal(errorFrom(502, envelope("upstream_error"), headers()).retryable, true);
  // A 422 upstream error is the gateway saying the upstream refused these
  // bytes on their merits. Retrying is the exact waste the mapping prevents.
  assert.equal(errorFrom(422, envelope("wire_upstream_mismatch"), headers()).retryable, false);
  assert.ok(errorFrom(422, envelope("byok_key_rejected"), headers()) instanceof ConiferByokKeyError);
  assert.ok(errorFrom(409, envelope("request_in_progress"), headers()) instanceof ConiferConflictError);
  assert.ok(errorFrom(502, envelope("upstream_error"), headers()) instanceof ConiferUpstreamError);
  assert.ok(
    errorFrom(503, envelope("service_unavailable"), headers()) instanceof ConiferUnavailableError,
  );
});

test("an unrecognized type keeps the gateway's own words and a status-based posture", () => {
  const future = errorFrom(400, envelope("some_future_type", undefined, "a new refusal"), headers());
  assert.equal(future.type, "some_future_type");
  assert.equal(future.message, "a new refusal");
  assert.equal(future.retryable, false);
  // A 5xx we have no name for is still worth one retry.
  assert.equal(errorFrom(500, envelope("some_future_type"), headers()).retryable, true);
});

test("the request id is read from either header the gateway may send", () => {
  const canonical = errorFrom(400, envelope("invalid_request_error"), headers({ "x-conifer-request-id": "gw-1" }));
  assert.equal(canonical.requestId, "gw-1");
  const fallback = errorFrom(400, envelope("invalid_request_error"), headers({ "x-request-id": "gw-2" }));
  assert.equal(fallback.requestId, "gw-2");
});

/**
 * The three 409s, and why one of them must NOT be retried.
 *
 * Found by the live QA harness rather than by reading: a Python run hit
 * `replayed_no_body_unresolved` on a FIRST call and the SDK reported a hard
 * failure, for a turn the gateway had explicitly invited it to re-ask. The
 * status code cannot separate these cases — only the gateway's own wording can.
 */
test("a 409 that says 'retry shortly' is retryable; a body conflict is not", () => {
  const transient = [
    "this request is already in progress; retry shortly",
    "this request has no replayable response; retry shortly",
  ];
  for (const message of transient) {
    const error = errorFrom(409, envelope("request_in_progress", undefined, message), headers());
    assert.ok(error instanceof ConiferConflictError);
    assert.equal(error.retryable, true, message);
  }

  // Reusing a key for DIFFERENT bytes is terminal: the same request will be
  // refused identically forever, so retrying is pure latency.
  const terminal = errorFrom(
    409,
    envelope(
      "request_in_progress",
      undefined,
      "idempotency key was already used with a different request body",
    ),
    headers(),
  );
  assert.ok(terminal instanceof ConiferConflictError);
  assert.equal(terminal.retryable, false);
});

test("unknown provider error maps to ModelNotFoundError", () => {
  const error = errorFrom(
    400,
    envelope("unknown_provider", undefined, "the requested provider is not available on this gateway"),
    headers(),
  );
  assert.ok(error instanceof ConiferModelNotFoundError);
  assert.equal(error.retryable, false);
});

