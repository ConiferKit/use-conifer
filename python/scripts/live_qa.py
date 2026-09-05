#!/usr/bin/env python3
"""Exercise every Python SDK surface against a REAL gateway.

Twin of ``scripts/live-qa.mjs``. The offline suite uses an injected transport,
which proves the SDK builds the bytes it intends to; this proves the gateway
agrees, and it is what "one SDK, two languages" has to mean in practice.

Every defect found in the 2026-08-27 QA pass was invisible offline and obvious
here: three error classes unreachable against the live error vocabulary,
``request_id`` inert because the gateway reads ``idempotency-key`` first, and
``chat(defer=True)`` returning an empty completion for a turn that had been
accepted AND DEBITED.

This release campaign requires an approved plan and ``--execute``. Both
languages share at most 40 POSTs and $1.850000002 in reserved ceilings.
Deferred jobs require a separate plan. Missing execution flags fail so an
older publisher cannot silently skip the mandatory live gate.
"""

from __future__ import annotations

import os
import base64
import struct
import math
import signal
import urllib.request
import json
import sys
import time
from pathlib import Path

if "--include-deferred" in sys.argv:
    raise SystemExit("deferred jobs require a separate bounded plan")
if "--execute" not in sys.argv:
    print("Local-only default. Review the bounded campaign plan; --execute requires fresh spend approval.")
    raise SystemExit(2)
if not os.environ.get("CONIFER_QA_RUN_DIR"):
    raise SystemExit("set CONIFER_QA_RUN_DIR to the reviewed campaign path")
if not os.environ.get("CONIFER_API_KEY"):
    raise SystemExit("set CONIFER_API_KEY explicitly; no credential discovery")
# Helpers are local, but conifer_sdk must come from the installed wheel.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from live_qa_transport import BASE_URL, BUILD, PINS, GuardedHTTP, assert_model, empty_outcome
import conifer_sdk
if conifer_sdk.__version__ != "0.2.1" or "site-packages" not in conifer_sdk.__file__:
    raise SystemExit("expected installed conifer-sdk0.2.1 wheel; source fallback is forbidden")
http = GuardedHTTP()
http.record("claim")
urllib.request.urlopen = http.urlopen
signal.alarm(900)
print(f"Installed wheel {conifer_sdk.__version__}: {conifer_sdk.__file__}")

from conifer_sdk import (  # noqa: E402
    ChatRequest,
    Conifer,
    ConiferAuthError,
    ConiferBadRequestError,
    ConiferCostCeilingError,
    ConiferModelNotFoundError,
    ConiferPortabilityError,
    EmbeddingsRequest,
    ReceiptCollector,
    SpendBudget,
    SpendBudgetExceeded,
    is_terminal_job,
    vector_of,
)

INCLUDE_DEFERRED = "--include-deferred" in sys.argv

_passed = 0
_failed = 0


def resolve_key() -> str:
    """Use only the explicitly supplied campaign credential."""
    if os.environ.get("CONIFER_API_KEY"):
        return os.environ["CONIFER_API_KEY"]
    raise SystemExit("set CONIFER_API_KEY explicitly; no credential discovery")


def check(name, run) -> None:
    global _passed, _failed
    http.case_name = name
    try:
        detail = run()
        _passed += 1
        print(f"  ok   {name}" + (f" — {detail}" if detail else ""))
    except Exception as error:  # noqa: BLE001 - a QA harness reports, never raises
        _failed += 1
        print(f"  FAIL {name}\n       {error}")


def eq(actual, expected, what) -> None:
    """Assert with the value in the message, so a failure is diagnosable."""
    if actual != expected:
        raise AssertionError(f"{what}: expected {expected!r}, got {actual!r}")


key = resolve_key()
conifer = Conifer(api_key=key, base_url=BASE_URL, max_retries=0, timeout=90)
health, _ = conifer.request("GET", "/healthz")
if not isinstance(health.get("build"), str) or not health["build"].endswith("+" + BUILD[:7]):
    raise SystemExit("gateway build differs from approved plan")
print(f"\nlive QA against {conifer.base_url}\n")

state = {}

# ------------------------------------------------------------------ catalog

print("catalog")


def _models():
    models = conifer.models()
    if not models:
        raise AssertionError("the catalog is empty")
    state["catalog"] = {m.id: m for m in models}
    state["chat"] = PINS["chat"]; state["embed"] = PINS["embed"]
    assert_model(state["catalog"].get(state["chat"]), 16, "tools", "openai")
    assert_model(state["catalog"].get(state["chat"]), 128, "tools", "openai")
    assert_model(state["catalog"].get(state["embed"]), None, "embeddings", "openai")
    if "qwen3.8-max" in state["catalog"]:
        eq(state["catalog"]["qwen3.8-max"].output_token_limit_supported, False, "unsupported limit parsed")
    if "glm-5.3-flash" in state["catalog"]:
        eq(state["catalog"]["glm-5.3-flash"].min_output_tokens, 512, "minimum output budget parsed")
    return f"{len(models)} models"


check("models() returns a priced, capability-declaring catalog", _models)
check("model(id) round-trips one entry", lambda: eq(conifer.model(state["chat"]).id, state["chat"], "model id"))


def _cheapest():
    # The regression this guards: parsing prices as numbers ranked the entire
    # live catalog as unpriced, so this returned nothing at all.
    cheap = conifer.cheapest_for(["embeddings"])
    if cheap is None:
        raise AssertionError("no cheapest embedding model — are prices parsing?")
    return cheap.id


check("cheapest_for ranks the catalog's own decimal-string prices", _cheapest)
def _balance():
    balance = conifer.balance()
    if type(balance.remaining_nano_usd) is not int or balance.remaining_nano_usd < 2_000_000_000:
        raise AssertionError("insufficient balance for the bounded plan")
    return f"{balance.remaining_usd} USD"
check("balance() reads without moving money", _balance)
if _failed:
    raise SystemExit("catalog/balance preflight failed; no inference dispatched")
http.record("ready")

# --------------------------------------------------------------------- chat

print("\nchat")


def _chat():
    answer = conifer.chat(
        ChatRequest(
            model=state["chat"],
            messages=[{"role": "user", "content": "reply with exactly: pinecone"}],
            max_tokens=128,
        )
    )
    eq(answer.text.strip(), "pinecone", "answer")
    if answer.receipt.cost_nano_usd is None:
        raise AssertionError("no cost on a non-streamed turn — the receipt is the product")
    return f"{answer.receipt.cost_usd} USD, {answer.receipt.effective_model}"


check("chat() returns an answer AND its exact settled cost", _chat)


def _request_id():
    # Was inert until 2026-08-27: the gateway reads `idempotency-key` first,
    # and the SDK always sends one, so `x-request-id` was never consulted.
    mine = f"live-qa-py-{int(time.time() * 1000)}"
    answer = conifer.chat(
        ChatRequest(
            model=state["chat"],
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=128,
            request_id=mine,
        )
    )
    eq(answer.receipt.request_id, mine, "request_id")
    return mine


def _cost_on_body():
    # A logging pipeline that keeps bodies and discards headers — which is most
    # of them — must still see what the turn cost. This is the field OpenRouter
    # puts cost in, so a migrating team's cost column keeps working.
    answer = conifer.chat(
        ChatRequest(
            model=state["chat"],
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=128,
        )
    )
    usage = answer.usage or {}
    if usage.get("cost_nanousd") is None:
        raise AssertionError("no cost on usage — a body-only logger would see nothing")
    eq(usage["cost_nanousd"], answer.receipt.cost_nano_usd, "body vs header cost")
    return f"{usage['cost']} USD on the body, matching the receipt"


check("the settled cost rides the BODY, not only the headers", _cost_on_body)

check("the caller's request_id is the id that comes back", _request_id)


def _stream():
    chunks = 0
    usage = None
    visible = ""
    for chunk in conifer.stream(
        ChatRequest(
            model=state["chat"],
            messages=[{"role": "user", "content": "Reply with exactly: 1,2,3"}],
            max_tokens=128,
        )
    ):
        chunks += 1
        visible += ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
        if chunk.get("usage"):
            usage = chunk["usage"]
    if chunks == 0:
        raise AssertionError("no chunks arrived")
    # The documented asymmetry: cost is absent on a stream because the head is
    # sent before the first token. Usage is how a stream is reconciled.
    if usage is None:
        raise AssertionError("no terminal usage chunk — a stream must be reconcilable")
    eq("".join(visible.split()), "1,2,3", "streamed content")
    http.stream_done(usage)
    if conifer.stream_receipt.cost_nano_usd is not None:
        raise AssertionError("a stream disclosed a cost on the head; the README says it cannot")
    return f"{chunks} chunks, {usage.get('total_tokens')} tokens"


check("stream() flows and reports usage in its terminal chunk", _stream)

def _empty_reason():
    # The trap: a reasoning model spends max_tokens on its thinking block
    # FIRST, so a tight budget yields empty content, finish_reason "length",
    # and a bill for every output token. Indistinguishable at the call site
    # from a refusal or a broken SDK unless something reads finish_reason.
    try:
        truncated = conifer.chat(ChatRequest(
            model=state["chat"],
            messages=[{"role": "user", "content": "What is 8347 * 9182? Think it through step by step."}],
            max_tokens=16,
        ))
    except Exception as error:
        return empty_outcome(error)
    if not truncated.text.strip():
        raise AssertionError("empty successful completion is invalid on this gateway")
    eq(truncated.empty_reason, None, "a visible completion needs no explanation")
    return "visible answer; no invented explanation"


check("an empty completion explains itself rather than just being empty", _empty_reason)

# --------------------------------------------------------------- embeddings

print("\nembeddings")


def _embeddings():
    # WHY THIS COMPARES ONE RESPONSE AGAINST ITSELF rather than two calls.
    #
    # The first version embedded the same text twice — once base64, once float
    # — and compared. It failed against `bge-m3`, and the SDK was not the
    # reason: that model is NON-DETERMINISTIC. Six identical float calls
    # returned FOUR distinct vectors differing by up to 2.2e-4, while
    # text-embedding-3-small returned the same bytes every time. Batched GPU
    # inference reorders float accumulation depending on what shares the batch.
    #
    # So a two-call comparison cannot isolate the decoder: a mismatch means
    # "either the decode is wrong or the provider is nondeterministic", which
    # is exactly the ambiguity a QA check must not have. Asking for BOTH
    # encodings of ONE inference removes the provider from the question.
    response = conifer.embed(
        EmbeddingsRequest(model=state["embed"], input="hello world", encoding_format="float")
    )
    decoded = vector_of(response)
    as_sent = response.raw["data"][0]["embedding"]
    if not isinstance(as_sent, list):
        raise AssertionError("`float` did not return a JSON array")
    eq(len(decoded), len(as_sent), "dimension")
    if decoded != as_sent:
        raise AssertionError("the decode altered the provider's own float array")

    # And the base64 path on its own response.
    packed = conifer.embed(EmbeddingsRequest(model=state["embed"], input="hello world"))
    unpacked = vector_of(packed)
    if not isinstance(packed.raw["data"][0]["embedding"], str):
        raise AssertionError("the default did not request base64")
    eq(len(unpacked), len(decoded), "base64 dimension")
    if not unpacked:
        raise AssertionError("base64 decoded to an EMPTY vector")
    raw_bytes = base64.b64decode(packed.raw["data"][0]["embedding"], validate=True)
    expected = list(struct.unpack(f"<{len(raw_bytes) // 4}f", raw_bytes))
    eq(unpacked, expected, "independent little-endian base64 decode")
    if not all(math.isfinite(value) for value in decoded + unpacked):
        raise AssertionError("non-finite embedding")
    eq(len(unpacked), state["catalog"][state["embed"]].embedding_dimensions, "advertised vector width")
    # Separate provider calls can drift; exact decoding uses each response above.
    drift = max(abs(x - y) for x, y in zip(unpacked, decoded))

    if packed.receipt.cost_nano_usd is None:
        raise AssertionError("embeddings settle in band; the cost must be on this response")
    return f"{len(decoded)} dims, decode exact, run-to-run drift {drift:.1e}"


check("embeddings decode losslessly, base64 and float alike", _embeddings)


def _batch():
    batch = conifer.embed(
        EmbeddingsRequest(model=state["embed"], input=["alpha", "beta", "gamma"])
    )
    eq(len(batch.data), 3, "count")
    eq([d.index for d in batch.data], [0, 1, 2], "order")
    return f"{len(batch.data)} vectors"


check("a batch returns one vector per input, in order", _batch)


def _wrong_door():
    try:
        conifer.embed(EmbeddingsRequest(model=state["chat"], input="hi"))
    except ConiferBadRequestError as error:
        return error.message[:48]
    raise AssertionError("a chat model was accepted on the embeddings door")


check("a chat model on the embeddings door is refused, legibly", _wrong_door)

# -------------------------------------------------------------------- money

print("\nmoney and refusals")


def _ceiling():
    try:
        conifer.chat(
            ChatRequest(
                model=state["chat"],
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=128,
                max_cost_nano_usd=1,
            )
        )
    except ConiferCostCeilingError as error:
        # The two amounts are what make this actionable rather than just a 402.
        if error.projected_nano_usd is None:
            raise AssertionError("no projected cost parsed") from error
        return f"projected {error.projected_nano_usd} > ceiling {error.ceiling_nano_usd}"
    raise AssertionError("the ceiling did not refuse")


check("a cost ceiling refuses BEFORE any upstream call", _ceiling)


def _unknown_model():
    try:
        conifer.chat(
            ChatRequest(
                model="no-such-model-xyz",
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=128,
            )
        )
    except ConiferModelNotFoundError as error:
        return error.code or error.type
    raise AssertionError("an unknown model was accepted")


check("an unknown model is a typed 404, not a hang", _unknown_model)


def _bad_key():
    # The exact regression that made three error classes unreachable.
    stranger = Conifer(api_key="sk-conifer-definitely-not-valid", base_url=BASE_URL, timeout=90, max_retries=0)
    try:
        stranger.balance()
    except ConiferAuthError as error:
        eq(error.retryable, False, "retryable")
        return f"{error.type} / {error.code}"
    raise AssertionError("a bogus key was accepted")


check("a bad credential is an auth error, not a bare ConiferError", _bad_key)

# ------------------------------------------------- receipts for any client

print("\nreceipts for any client")


def _collector():
    # Exercised through the SDK's own transport, which is the same shape any
    # response-like object has: the collector is duck-typed on headers.
    receipts = ReceiptCollector()
    _, headers = conifer.request(
        "POST",
        "/v1/chat/completions",
        {
            "model": state["chat"],
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 128,
        },
    )
    observed = receipts.observe(headers, "/v1/chat/completions")
    if observed is None or observed.cost_nano_usd is None:
        raise AssertionError("no receipt captured")
    return f"{receipts.total.cost_usd} USD over {receipts.total.turns} turn(s)"


check("ReceiptCollector reads a receipt off a real response", _collector)


def _budget():
    budget = SpendBudget(1)  # 1 nanodollar: the first turn blows it
    _, headers = conifer.request(
        "POST",
        "/v1/chat/completions",
        {
            "model": state["chat"],
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 128,
        },
    )
    budget.collector.observe(headers)
    if not budget.exhausted:
        raise AssertionError("the budget should be exhausted")
    try:
        budget.check()
    except SpendBudgetExceeded:
        return f"refused after {budget.spent_nano_usd} nUSD"
    raise AssertionError("the budget did not refuse")


check("SpendBudget refuses once spent", _budget)

# ----------------------------------------------------------------- deferred

print("\ndeferred jobs")


def _chat_refuses_defer():
    try:
        conifer.chat(
            ChatRequest(
                model=state["chat"],
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=128,
                defer=True,
            )
        )
    except ConiferPortabilityError as error:
        eq(error.field, "defer", "field")
        return "refused client-side, no spend"
    raise AssertionError("chat() accepted defer and returned something")


check("chat() refuses a deferred turn rather than returning nothing", lambda: http.without_egress(_chat_refuses_defer))

if INCLUDE_DEFERRED:

    def _defer_cycle():
        job = conifer.defer(
            ChatRequest(
                model=state["chat"],
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=128,
            )
        )
        if not job.job_id:
            raise AssertionError("no job id")
        status = conifer.job_status(job.job_id)
        if is_terminal_job(status.status):
            raise AssertionError(f"already terminal: {status.status}")
        cancelled = conifer.job_cancel(job.job_id)
        if not is_terminal_job(cancelled.status):
            raise AssertionError(f"cancel left a non-terminal state: {cancelled.status}")
        return f"{job.status} -> {cancelled.status}"

    check("defer() submits, status polls, cancel terminates", _defer_cycle)

    def _foreign_job():
        try:
            conifer.job_status("job-gw-definitely-not-a-real-job")
        except ConiferModelNotFoundError as error:
            return error.type
        raise AssertionError("a nonexistent job id was found")

    check("a foreign job id is a 404 with no existence oracle", _foreign_job)
else:
    print("  skip deferred submit/cancel (requires a separate bounded plan)")

print(f"\n{'PASS' if _failed == 0 else 'FAIL'} — {_passed} passed, {_failed} failed\n")
print(http.record("finish", failed_checks=_failed))
signal.alarm(0)
sys.exit(0 if _failed == 0 else 1)
