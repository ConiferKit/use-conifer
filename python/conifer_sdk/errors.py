"""One error class per gateway ``error.type`` — the Python twin of src/errors.ts.

Branching on a name rather than a status is the whole point: a 402 is either
"the account is out of credit" or "your own ceiling refused this turn", and the
remedies are opposite.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence


class ConiferError(Exception):
    """Base class. Every Conifer failure carries these fields."""

    #: Whether re-sending the SAME bytes could plausibly succeed. Only transport
    #: faults and 429/502/503/504 qualify: a 4xx the gateway authored refuses
    #: the same bytes again, so retrying it is pure latency and burnt quota.
    retryable: bool = False

    def __init__(
        self,
        status: int,
        type: str,
        message: str,
        code: Optional[str] = None,
        param: Optional[str] = None,
        request_id: Optional[str] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.type = type
        self.message = message
        #: The OpenAI-compatible ``error.code``, when the gateway sent one.
        #:
        #: Not decoration: the gateway speaks the INDUSTRY vocabulary, in which
        #: ``type`` collapses a 401 and a 400 into one ``invalid_request_error``.
        #: ``code`` is what separates them (``invalid_api_key``,
        #: ``model_not_found``, ``context_length_exceeded``,
        #: ``unsupported_parameter``, ``unknown_url``, …), and it is the field
        #: LangChain, LiteLLM and openai-python already branch on.
        self.code = code
        #: The OpenAI-compatible ``error.param`` — the request field the
        #: refusal is about (``tools``, ``tool_choice``, ``messages``,
        #: ``max_tokens``, ``model``). Present on field-scoped refusals only.
        self.param = param
        self.request_id = request_id
        self.body = body


class ConiferAuthError(ConiferError):
    """401."""


class ConiferPaymentError(ConiferError):
    """402: the billed account cannot cover this turn's worst case."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Anchored on the gateway's wording, never "the first two integers": a
        # delegated key's message opens with the billed ACCOUNT id, whose digits
        # were being read as the amount. The 402 body carries the balance
        # structured (``error.balance_nanodollars``); that wins over the prose.
        self.required_nano_usd = _integer_after(self.message, r"needs up to (-?\d+) nanodollars")
        self.balance_nano_usd = _structured_balance(self.body)
        if self.balance_nano_usd is None:
            self.balance_nano_usd = _integer_after(self.message, r"holds? (-?\d+)")


class ConiferCostCeilingError(ConiferError):
    """402: YOUR ``max_cost_nano_usd`` refused it, before any upstream call."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.projected_nano_usd, self.ceiling_nano_usd = _two_integers(self.message)


class ConiferKeySpendCapError(ConiferError):
    """402: this API KEY's own lifetime spend cap is exhausted.

    The THIRD distinct 402, and the reason branching on status is not enough.
    All three are 402, nothing is charged for any of them, and the remedy
    differs in each case:

    - :class:`ConiferPaymentError` — the ACCOUNT is out of credit. Add funds.
    - :class:`ConiferCostCeilingError` — YOUR per-request ceiling refused this
      turn. Raise it, or send less.
    - :class:`ConiferKeySpendCapError` — the KEY you are holding has spent its
      lifetime cap. The account may be fully funded and every other key still
      works; the fix is a new key or a raised cap, and adding credit does
      nothing at all.
    """


class ConiferBadRequestError(ConiferError):
    """400."""


class ConiferCapabilityError(ConiferBadRequestError):
    """400: the MODEL cannot serve this request's shape.

    Its published catalog ``caps`` omit a capability the request uses, or a
    declared ceiling is exceeded. The gateway refuses BEFORE any charge, with
    ``code: unsupported_parameter`` (or ``invalid_value``) and ``param`` naming
    the field: ``messages`` when the request carries images a no-vision model
    cannot take, ``tools``/``tool_choice`` on a no-tool model, ``tools`` again
    for an over-``max_tools`` array.

    This is the ONE 400 a different model can fix — a statement about the
    PAIRING of this request with this model, not about the bytes. Catch it to
    re-route to a capable model (e.g. an image turn from ``deepseek-v4-flash``
    to ``glm-5.3-flash``). Born from the 2026-08-29 OpenTag incident: an image
    turn on a text-only model came back as provider-prose upstream errors and
    was retried to death; now it is this class on the first try.
    """

    #: A different model may serve these bytes; the same model never will.
    model_switchable = True


class ConiferModelNotFoundError(ConiferError):
    """404.

    The gateway deliberately cannot distinguish "no such model" from "a model
    you may not see": both are absent from your catalog listing and both render
    this refusal. Do not treat it as proof of non-existence.
    """


class ConiferConflictError(ConiferError):
    """409: an idempotency key that cannot be answered right now.

    The gateway authors THREE different 409s under this one type, and they do
    not mean the same thing (``handlers.rs``, measured live 2026-08-27):

    - "idempotency key was already used with a different request body" —
      TERMINAL. You reused a key for different bytes. Retrying re-sends the
      same conflict forever; change the key or the body.
    - "this request is already in progress; retry shortly" — TRANSIENT. A first
      attempt is still in flight, possibly on another replica.
    - "this request has no replayable response; retry shortly" — TRANSIENT. The
      key is known but the body lives in another replica's cache, and the
      gateway will not guess between "settled elsewhere" and "still running"
      because either guess can double-charge or wrongly refund.

    The last two are the gateway explicitly asking to be asked again, and
    retrying them is SAFE precisely because the key is the same — that is what
    idempotency is for. So ``retryable`` is decided by the gateway's own
    wording rather than by the status code, which cannot tell these apart.

    Found by the live QA harness: a run hit ``replayed_no_body_unresolved`` on
    a FIRST call, and the SDK surfaced a hard failure for a turn the gateway
    was willing to serve on a second ask.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.retryable = bool(re.search(r"retry shortly", self.message, re.IGNORECASE))


class ConiferByokKeyError(ConiferError):
    """422: your own provider key was rejected or is marked failed."""


class ConiferRateLimitError(ConiferError):
    """429."""

    retryable = True

    def __init__(self, retry_after_seconds: Optional[int] = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.retry_after_seconds = retry_after_seconds


class ConiferUpstreamError(ConiferError):
    """502 (transport-shaped, retryable) or 422 (refused on the merits)."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.retryable = self.status >= 500


class ConiferUnavailableError(ConiferError):
    """503."""

    retryable = True


class ConiferTimeoutError(ConiferError):
    """No verdict arrived. We make no claim about whether the turn was billed."""

    retryable = True

    def __init__(self, message: str, request_id: Optional[str] = None) -> None:
        super().__init__(status=0, type="timeout", message=message, request_id=request_id)


class ConiferConnectionError(ConiferError):
    """The socket failed. Same "no verdict" caveat as the timeout."""

    retryable = True

    def __init__(self, message: str, cause: Any = None) -> None:
        super().__init__(status=0, type="connection_error", message=message, body=cause)


class ConiferPortabilityError(ConiferError):
    """A migration input Conifer cannot honor.

    Raised, never swallowed: dropping a spend ceiling, a provider restriction,
    or a moderation flag would make a migration LOOK successful while quietly
    changing what runs and what it costs.
    """

    def __init__(self, field: str, message: str) -> None:
        super().__init__(status=0, type="unsupported_by_conifer", message=message)
        self.field = field


def _integer_after(message: str, pattern: str) -> Optional[int]:
    found = re.search(pattern, message)
    return int(found.group(1)) if found else None


def _structured_balance(body: Any) -> Optional[int]:
    envelope = body.get("error") if isinstance(body, dict) else None
    value = envelope.get("balance_nanodollars") if isinstance(envelope, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _two_integers(message: str) -> tuple[Optional[int], Optional[int]]:
    found: Sequence[str] = re.findall(r"-?\d+", message)
    first = int(found[0]) if len(found) > 0 else None
    second = int(found[1]) if len(found) > 1 else None
    return first, second


#: The gateway's RETIRED private type names, kept so an older deploy or a
#: recorded fixture maps to exactly the same class. The names it speaks now
#: (``invalid_request_error``, ``rate_limit_error``) are industry vocabulary
#: and are resolved by code+status in :func:`error_from`, not by this table.
_BY_TYPE = {
    "unauthorized": ConiferAuthError,
    "insufficient_allowance": ConiferPaymentError,
    "cost_ceiling_exceeded": ConiferCostCeilingError,
    "key_spend_cap_exceeded": ConiferKeySpendCapError,
    # 404. A BYOK provider name the gateway does not serve — a caller-side typo
    # in the same family as a model that does not exist, so it shares the class
    # a caller already handles for "that name is not a thing here".
    "unknown_provider": ConiferModelNotFoundError,
    "invalid_request": ConiferBadRequestError,
    "model_not_found": ConiferModelNotFoundError,
    "job_not_found": ConiferModelNotFoundError,
    "request_in_progress": ConiferConflictError,
    "byok_key_rejected": ConiferByokKeyError,
    "service_unavailable": ConiferUnavailableError,
    "upstream_error": ConiferUpstreamError,
    "wire_upstream_mismatch": ConiferUpstreamError,
}


def error_from(status: int, body: Any, headers: Mapping[str, str]) -> ConiferError:
    """Map a gateway refusal onto its class.

    THE ``invalid_request_error`` COLLAPSE (measured live 2026-08-27). The
    gateway speaks the INDUSTRY error vocabulary rather than a third schema of
    its own: a 401 and a 400 both render ``type: "invalid_request_error"`` and a
    429 renders ``rate_limit_error``, because that is what OpenAI, Groq,
    Together, Fireworks, DeepSeek and xAI send and therefore what every existing
    client already branches on.

    That collapse is good for portability and fatal for a lookup on ``type``
    alone. An earlier version of this function keyed only the gateway's older
    private names (``unauthorized``, ``invalid_request``, ``rate_limited``),
    which the gateway has since retired — so :class:`ConiferAuthError`,
    :class:`ConiferBadRequestError` and :class:`ConiferRateLimitError` were
    UNREACHABLE against the live gateway, every 401 and 400 arrived as a bare
    :class:`ConiferError`, and a 429 lost its ``retry-after``.

    So the discriminator is (type, code, status), in that order of authority.
    """
    envelope = body.get("error") if isinstance(body, dict) else None
    envelope = envelope if isinstance(envelope, dict) else {}
    type_ = envelope.get("type") if isinstance(envelope.get("type"), str) else f"http_{status}"
    code = envelope.get("code") if isinstance(envelope.get("code"), str) else None
    param = envelope.get("param") if isinstance(envelope.get("param"), str) else None
    message = (
        envelope.get("message")
        if isinstance(envelope.get("message"), str)
        else f"the gateway refused with HTTP {status}"
    )
    lowered = {key.lower(): value for key, value in headers.items()}
    request_id = lowered.get("x-conifer-request-id") or lowered.get("x-request-id")
    kwargs: dict[str, Any] = {
        "status": status,
        "type": type_,
        "code": code,
        "param": param,
        "message": message,
        "request_id": request_id,
        "body": body,
    }

    def _rate_limited() -> ConiferRateLimitError:
        raw = lowered.get("retry-after")
        try:
            retry_after = int(raw) if raw is not None else None
        except ValueError:
            retry_after = None
        return ConiferRateLimitError(retry_after_seconds=retry_after, **kwargs)

    # The industry-vocabulary types, resolved by code then status.
    if type_ == "invalid_request_error":
        if code == "invalid_api_key" or status in (401, 403):
            return ConiferAuthError(**kwargs)
        if code == "model_not_found" or status == 404:
            return ConiferModelNotFoundError(**kwargs)
        # A capability refusal is a statement about THIS model, not these
        # bytes: ``unsupported_parameter`` = the published caps do not cover
        # the request (images on a no-vision model, tools on a no-tool model);
        # ``invalid_value`` on ``tools`` = the array exceeds ``max_tools``.
        # Both are exactly what a fallback to a more capable model fixes.
        if code == "unsupported_parameter" or (code == "invalid_value" and param == "tools"):
            return ConiferCapabilityError(**kwargs)
        return ConiferBadRequestError(**kwargs)
    if type_ in ("rate_limit_error", "rate_limited"):
        return _rate_limited()

    cls = _BY_TYPE.get(type_)
    if cls is not None:
        return cls(**kwargs)
    # Unknown code: fall back to the STATUS for retryability only, keeping the
    # gateway's own type string intact so a new code is still readable.
    if status >= 500 or status == 429:
        return ConiferUnavailableError(**kwargs)
    return ConiferError(**kwargs)
