"""One error class per kind of gateway refusal. Branch on the class, not the
status: a 402 alone does not say whether to add credit, raise a ceiling, or
mint a new key."""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence


class ConiferError(Exception):
    """Base class. Every Conifer failure carries these fields."""

    #: Whether re-sending the same bytes could succeed. Transport faults and 429/5xx only.
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
        #: The OpenAI-compatible ``error.code``, which distinguishes refusals that share a ``type``.
        self.code = code
        #: The request field the refusal is about, when it is field-scoped.
        self.param = param
        self.request_id = request_id
        #: The raw envelope.
        self.body = body


class ConiferAuthError(ConiferError):
    """401 or 403."""


class ConiferPaymentError(ConiferError):
    """402: the account is out of credit. Add funds."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        #: Worst-case cost of the refused request, in nanodollars.
        self.required_nano_usd = _integer_after(self.message, r"needs up to (-?\d+) nanodollars")
        #: What the billed account holds, in nanodollars.
        self.balance_nano_usd = _structured_balance(self.body)
        if self.balance_nano_usd is None:
            self.balance_nano_usd = _integer_after(self.message, r"holds? (-?\d+)")


class ConiferCostCeilingError(ConiferError):
    """402: your own ``max_cost_nano_usd`` refused this request. Raise it or send less."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.projected_nano_usd, self.ceiling_nano_usd = _two_integers(self.message)


class ConiferKeySpendCapError(ConiferError):
    """402: this API key's lifetime spend cap is spent. Adding credit does
    nothing; raise the cap or mint a key."""


class ConiferBadRequestError(ConiferError):
    """400."""


class ConiferCapabilityError(ConiferBadRequestError):
    """400: this model cannot take this request's shape (images on a
    no-vision model, tools on a no-tool model). The one 400 a different model
    fixes; catch it to re-route."""

    #: A different model may serve these bytes; the same model never will.
    model_switchable = True


class ConiferModelNotFoundError(ConiferError):
    """404. The gateway does not distinguish "no such model" from "not in your catalog"."""


class ConiferConflictError(ConiferError):
    """409: an idempotency key that cannot be answered right now. Retryable
    when the gateway says "retry shortly" (a first attempt is still in
    flight); terminal when the key was reused with a different body."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.retryable = bool(re.search(r"retry shortly", self.message, re.IGNORECASE))


class ConiferByokKeyError(ConiferError):
    """The provider rejected your own key on the BYOK lane."""


class ConiferRateLimitError(ConiferError):
    """429."""

    retryable = True

    def __init__(self, retry_after_seconds: Optional[int] = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        #: From the ``retry-after`` header, when sent.
        self.retry_after_seconds = retry_after_seconds


class ConiferUpstreamError(ConiferError):
    """The upstream provider failed. A 502 may be retried; a 422 refused these bytes on their merits."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.retryable = self.status >= 500


class ConiferUnavailableError(ConiferError):
    """503."""

    retryable = True


class ConiferTimeoutError(ConiferError):
    """No verdict arrived in time. Whether the turn was billed is unknown."""

    retryable = True

    def __init__(self, message: str, request_id: Optional[str] = None) -> None:
        super().__init__(status=0, type="timeout", message=message, request_id=request_id)


class ConiferConnectionError(ConiferError):
    """The socket failed. Whether the turn was billed is unknown."""

    retryable = True

    def __init__(self, message: str, cause: Any = None) -> None:
        super().__init__(status=0, type="connection_error", message=message, body=cause)


class ConiferPortabilityError(ConiferError):
    """A request carries something Conifer cannot honour. Raised rather than
    dropped, so a migration never silently changes what runs or what it costs."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(status=0, type="unsupported_by_conifer", message=message)
        #: The field with no Conifer equivalent.
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


#: The gateway's retired private type names, still accepted.
_BY_TYPE = {
    "unauthorized": ConiferAuthError,
    "insufficient_allowance": ConiferPaymentError,
    "cost_ceiling_exceeded": ConiferCostCeilingError,
    "key_spend_cap_exceeded": ConiferKeySpendCapError,
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
    """Map a refusal onto its class. The gateway speaks the industry
    vocabulary, where ``invalid_request_error`` covers 400, 401 and 404, so
    the discriminator is ``type``, then ``code``, then status. Unknown types
    stay a plain :class:`ConiferError`."""
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

    if type_ == "invalid_request_error":
        if code == "invalid_api_key" or status in (401, 403):
            return ConiferAuthError(**kwargs)
        if code == "model_not_found" or status == 404:
            return ConiferModelNotFoundError(**kwargs)
        if code == "unsupported_parameter" or (code == "invalid_value" and param == "tools"):
            return ConiferCapabilityError(**kwargs)
        return ConiferBadRequestError(**kwargs)
    if type_ in ("rate_limit_error", "rate_limited"):
        return _rate_limited()

    cls = _BY_TYPE.get(type_)
    if cls is not None:
        return cls(**kwargs)
    if status >= 500 or status == 429:
        return ConiferUnavailableError(**kwargs)
    return ConiferError(**kwargs)
