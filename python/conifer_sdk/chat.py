"""The wire shape of one chat turn: body, headers, the model chain, and the
idempotency key that ties retries together."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from .errors import ConiferPortabilityError
from .receipt import Receipt
from .types import ChatRequest

#: The gateway accepts at most this many server-side fallback models.
MAX_SERVER_FALLBACK_MODELS = 3


def chat_body(request: ChatRequest, stream: bool = False) -> Dict[str, Any]:
    """The JSON body for ``POST /v1/chat/completions``."""
    body: Dict[str, Any] = {"model": request.model, "messages": request.messages}
    optional = {
        "max_tokens": request.max_tokens,
        "temperature": request.temperature,
        "top_p": request.top_p,
        "stop": request.stop,
        "tools": request.tools,
        "tool_choice": request.tool_choice,
        "response_format": request.response_format,
        "reasoning": request.reasoning,
        "completion_window_seconds": request.deadline_seconds,
    }
    for name, value in optional.items():
        if value is not None:
            body[name] = value
    if request.defer:
        body["defer"] = "allow"
    if stream:
        body["stream"] = True
        # The final usage chunk is what lets a streamed turn be reconciled.
        body["stream_options"] = {"include_usage": True}
    body.update(request.extra_body)
    return body


def chat_headers(request: ChatRequest, idempotency_key: str) -> Dict[str, str]:
    """The request headers for one chat turn. Raises on values the wire cannot carry."""
    headers = dict(request.headers)
    headers["idempotency-key"] = idempotency_key
    if request.max_cost_nano_usd is not None:
        headers["x-conifer-max-cost-nanousd"] = cost_ceiling(request.max_cost_nano_usd)
    if request.deadline_seconds is not None:
        headers["x-conifer-deadline"] = str(request.deadline_seconds)
    if request.defer:
        headers["x-conifer-defer"] = "allow"
    if request.venue is not None:
        headers["x-conifer-venue"] = request.venue
    if request.prompt_cache == "off":
        headers["x-conifer-cache"] = "off"
    if request.request_id is not None:
        headers["x-request-id"] = request.request_id
    if request.client is not None:
        headers["x-conifer-client"] = request.client
    if request.server_fallback_models is not None:
        chain = server_fallback_header(request.server_fallback_models, request.model)
        if chain is not None:
            headers["x-conifer-fallback-models"] = chain
    return headers


def cost_ceiling(nano_usd: Any) -> str:
    """A spend ceiling is an integer number of nanodollars. Fractions are refused, not rounded."""
    if not isinstance(nano_usd, int) or isinstance(nano_usd, bool):
        raise ConiferPortabilityError(
            "max_cost_nano_usd",
            "the cost ceiling is an INTEGER nanodollar amount ($1 = 1e9). A fractional "
            "value is refused rather than rounded.",
        )
    return str(nano_usd)


def server_fallback_header(models: List[str], primary: str) -> Optional[str]:
    """The ``x-conifer-fallback-models`` value, validated as the gateway validates
    it: blank, comma-bearing or non-ASCII members raise; duplicates and the
    primary are dropped; at most three survive. ``None`` when nothing survives."""
    trimmed = [m.strip() for m in models]
    if any(m == "" for m in trimmed):
        raise ConiferPortabilityError(
            "server_fallback_models",
            "a fallback member is empty. Drop it, or drop the field if you do not want fallbacks.",
        )
    for m in trimmed:
        if "," in m or not m.isascii() or not m.isprintable():
            raise ConiferPortabilityError(
                "server_fallback_models",
                f"`{m}` cannot ride a comma-separated ASCII header.",
            )
    chain: List[str] = []
    for model in trimmed:
        if model == primary.strip() or model in chain:
            continue
        chain.append(model)
    if len(chain) > MAX_SERVER_FALLBACK_MODELS:
        raise ConiferPortabilityError(
            "server_fallback_models",
            f"at most {MAX_SERVER_FALLBACK_MODELS} fallback models are accepted per request.",
        )
    return ",".join(chain) if chain else None


def resolve_chain(request: ChatRequest) -> List[str]:
    """The models ``chat()`` will try, in order. A client-side chain is a
    sequence of separately billed requests, so it has to be opted into."""
    fallbacks = request.fallback_models or []
    if not fallbacks:
        return [request.model]
    if not request.allow_client_fallback:
        raise ConiferPortabilityError(
            "fallback_models",
            "fallback_models is a CLIENT-SIDE chain of separate billed requests. Set "
            "allow_client_fallback=True to accept that, or use server_fallback_models "
            "for one request.",
        )
    return [request.model, *fallbacks]


def turn_identity(request: Any) -> str:
    """The idempotency key for one logical turn. The gateway derives its
    request id from this header, so an explicit ``request_id`` becomes the key.
    Pass ``idempotency_key`` to control the two separately."""
    return request.idempotency_key or request.request_id or f"idem-{uuid.uuid4()}"


def with_cost(usage: Optional[Dict[str, Any]], receipt: Receipt) -> Optional[Dict[str, Any]]:
    """Copy the settled cost from the receipt onto ``usage``, where
    OpenRouter-shaped code looks for it. A server-provided ``cost`` wins, and
    an absent cost stays absent."""
    if receipt.cost_nano_usd is None:
        return usage
    existing = dict(usage or {})
    if existing.get("cost") is not None:
        return usage
    existing["cost"] = receipt.cost_nano_usd / 1_000_000_000
    existing["cost_nanousd"] = receipt.cost_nano_usd
    return existing
