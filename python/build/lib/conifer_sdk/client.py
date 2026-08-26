"""The Python client. Twin of src/client.ts, standard library only.

The transport is ``urllib`` behind an injectable ``transport`` callable, so
tests drive real request bytes without a network and without a mock framework.
"""

from __future__ import annotations

import json
import os
import random
import time
import ssl
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple

from .errors import (
    ConiferConnectionError,
    ConiferError,
    ConiferPortabilityError,
    ConiferTimeoutError,
    error_from,
)
from .receipt import Receipt, nano_usd_to_usd_string, read_receipt
from .types import Balance, CatalogModel, ChatRequest, Completion

DEFAULT_BASE_URL = "https://api.conifer.build"
#: Matches the gateway's own 300s edge silent-cut, so the client never gives up
#: on a turn the gateway is still serving (and still going to bill).
DEFAULT_TIMEOUT_SECONDS = 300.0

_RETRYABLE_STATUS = {429, 502, 503, 504}

#: (status, headers, body-text)
TransportResult = Tuple[int, Dict[str, str], str]
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], TransportResult]


def resolve_base_url(explicit: Optional[str], env: Mapping[str, str]) -> str:
    """Pick the gateway origin.

    ``CONIFER_BASE_URL`` wins. ``OPENAI_BASE_URL`` is honored ONLY when it
    already points at a Conifer host: a drop-in env should survive adopting the
    SDK, but a stray OpenAI base URL must never redirect Conifer traffic to
    someone else's gateway with a Conifer key in the header.
    """
    chosen = explicit or env.get("CONIFER_BASE_URL")
    if chosen is None:
        candidate = env.get("OPENAI_BASE_URL")
        if candidate is not None and _is_conifer_host(candidate):
            chosen = candidate
    chosen = chosen or DEFAULT_BASE_URL
    chosen = chosen.rstrip("/")
    # The SDK owns the /v1 suffix (the Anthropic door has none), so strip it.
    return chosen[:-3] if chosen.endswith("/v1") else chosen


def _is_conifer_host(url: str) -> bool:
    from urllib.parse import urlparse

    try:
        host = urlparse(url).hostname
    except ValueError:
        return False
    return host is not None and host.endswith("conifer.build")


def _ssl_context() -> Optional["ssl.SSLContext"]:
    """The system trust store, falling back to certifi when it is unusable.

    A python.org install whose ``Install Certificates.command`` was never run
    has an EMPTY trust store, so every HTTPS call fails with
    CERTIFICATE_VERIFY_FAILED — including this one. When ``certifi`` happens to
    be installed we use its bundle rather than failing, and when it is not we
    let the real error through (see the diagnosis in ``request``): silently
    disabling verification would be the other way to make this "work", and that
    is not a trade this SDK gets to make on a caller's behalf.
    """
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) > 0:
        return context
    try:
        import certifi
    except ImportError:
        return context
    return ssl.create_default_context(cafile=certifi.where())


def _urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> TransportResult:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_ssl_context()) as response:
            return (
                response.status,
                {key.lower(): value for key, value in response.headers.items()},
                response.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as error:  # a refusal is a RESULT, not a fault
        return (
            error.code,
            {key.lower(): value for key, value in (error.headers or {}).items()},
            error.read().decode("utf-8"),
        )


class Conifer:
    """The Conifer gateway client."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = 2,
        default_headers: Optional[Dict[str, str]] = None,
        transport: Optional[Transport] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        environment = env if env is not None else os.environ
        key = api_key or environment.get("CONIFER_API_KEY")
        if not key:
            raise ConiferError(
                status=0,
                type="missing_api_key",
                message=(
                    "CONIFER_API_KEY is missing. Mint one at "
                    "https://conifer.build/console#/keys and pass it as api_key "
                    "or set the environment variable."
                ),
            )
        self.api_key = key
        self.base_url = resolve_base_url(base_url, environment)
        self.timeout = timeout
        self.max_retries = max_retries
        self.default_headers = dict(default_headers or {})
        self._transport: Transport = transport or _urllib_transport
        #: The routing receipt of the most recent :meth:`stream` call. Cost
        #: fields are absent on a stream; see that method's note.
        self.stream_receipt: Optional[Receipt] = None

    # ------------------------------------------------------------- transport

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Tuple[Any, Dict[str, str]]:
        """One request, with the narrow retry rule."""
        url = f"{self.base_url}{path}"
        merged = dict(self.default_headers)
        merged.update(headers or {})
        merged["authorization"] = f"Bearer {self.api_key}"
        merged["accept"] = "application/json"
        payload: Optional[bytes] = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            merged["content-type"] = "application/json"

        last: Optional[ConiferError] = None
        for attempt in range(self.max_retries + 1):
            try:
                status, response_headers, text = self._transport(
                    method, url, merged, payload, self.timeout
                )
            except TimeoutError as cause:
                last = ConiferTimeoutError(
                    f"no response within {self.timeout}s; the turn may still have been "
                    "served and billed"
                )
                if attempt < self.max_retries:
                    time.sleep(backoff_seconds(attempt))
                    continue
                raise last from cause
            except OSError as cause:
                # Name a TLS trust failure for what it is. It is NOT "the
                # gateway is unreachable": the host answered, this Python just
                # cannot verify anyone's certificate — most often a python.org
                # install whose "Install Certificates.command" was never run.
                # Reported as connectivity, it sends the reader to look at the
                # gateway, the key, and the network, none of which are wrong.
                if isinstance(cause, ssl.SSLCertVerificationError) or (
                    isinstance(getattr(cause, "reason", None), ssl.SSLCertVerificationError)
                ):
                    raise ConiferConnectionError(
                        f"TLS certificate verification failed for {url}. This Python has no "
                        "usable CA trust store, so it cannot verify ANY https host. On macOS "
                        'run "/Applications/Python 3.x/Install Certificates.command", or '
                        "`pip install certifi`. The gateway itself is reachable.",
                        cause,
                    ) from cause
                last = ConiferConnectionError(f"could not reach the gateway at {url}", cause)
                if attempt < self.max_retries:
                    time.sleep(backoff_seconds(attempt))
                    continue
                raise last from cause

            parsed = _parse_json(text, status)
            if 200 <= status < 300:
                return parsed, response_headers

            failure = error_from(status, parsed, response_headers)
            if failure.retryable and status in _RETRYABLE_STATUS and attempt < self.max_retries:
                hinted = getattr(failure, "retry_after_seconds", None)
                time.sleep(hinted if hinted is not None else backoff_seconds(attempt))
                last = failure
                continue
            raise failure

        raise last or ConiferConnectionError("request loop exhausted")

    # ---------------------------------------------------------------- stream

    def stream(self, request: ChatRequest) -> Iterator[Dict[str, Any]]:
        """Stream one turn, yielding raw OpenAI chunks.

        The terminal ``usage`` chunk is always requested, because a streamed
        turn that cannot report its own tokens is one the caller cannot
        reconcile — and on a stream that chunk is the ONLY cost signal: the
        response head is sent before the first token, so the ``x-conifer-cost-*``
        headers are necessarily absent (measured live 2026-08-26). Read
        :attr:`stream_receipt` after the loop for the routing half.

        A fallback chain cannot ride a stream: the first token commits the turn,
        so a mid-stream switch would be a second billed turn stitched onto the
        first without the caller seeing the seam.
        """
        if request.fallback_models:
            raise ConiferPortabilityError(
                "fallback_models+stream",
                "a client-side fallback chain cannot be applied to a stream: the first "
                "token commits the turn. Call chat() for a chain, or handle the failure "
                "and re-stream yourself.",
            )
        key = request.idempotency_key or f"idem-{uuid.uuid4()}"
        headers = chat_headers(request, key)
        headers["accept"] = "text/event-stream"
        response = self._open_stream(chat_body(request, stream=True), headers)
        self.stream_receipt = read_receipt(response.headers)
        try:
            for line in response:
                chunk = parse_frame(line.decode("utf-8"))
                if chunk is not None:
                    yield chunk
        finally:
            response.close()

    def _open_stream(self, body: Dict[str, Any], headers: Dict[str, str]) -> Any:
        """The raw SSE response. Separate from :meth:`request` on purpose: a
        stream is not retryable (bytes already delivered cannot be un-delivered)
        and must not be buffered."""
        merged = dict(self.default_headers)
        merged.update(headers)
        merged["authorization"] = f"Bearer {self.api_key}"
        merged["content-type"] = "application/json"
        url = f"{self.base_url}/v1/chat/completions"
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), headers=merged, method="POST"
        )
        try:
            return urllib.request.urlopen(req, timeout=self.timeout, context=_ssl_context())
        except urllib.error.HTTPError as error:
            raise error_from(
                error.code,
                _parse_json(error.read().decode("utf-8"), error.code),
                {k.lower(): v for k, v in (error.headers or {}).items()},
            ) from error

    # ------------------------------------------------------------------ chat

    def chat(self, request: ChatRequest) -> Completion:
        """One chat turn, returned with the settled cost of that exact call."""
        chain = resolve_chain(request)
        idempotency_key = request.idempotency_key or f"idem-{uuid.uuid4()}"
        last: Optional[ConiferError] = None

        for index, model in enumerate(chain):
            member = ChatRequest(**{**request.__dict__, "model": model})
            key = idempotency_key if index == 0 else f"{idempotency_key}-{index}"
            try:
                data, headers = self.request(
                    "POST",
                    "/v1/chat/completions",
                    chat_body(member),
                    chat_headers(member, key),
                )
            except ConiferError as error:
                last = error
                # Only a retryable refusal advances the chain: a 402 or a 400 is
                # the caller's problem on every member alike, and spending on a
                # second model would not fix it.
                if not error.retryable or index == len(chain) - 1:
                    raise
                continue

            payload = data if isinstance(data, dict) else {}
            return Completion(
                choices=payload.get("choices") or [],
                receipt=read_receipt(headers),
                fallback_index=index,
                id=payload.get("id"),
                model=payload.get("model"),
                usage=payload.get("usage"),
                raw=payload,
            )

        raise last or ConiferError(status=0, type="empty_chain", message="no model to call")

    # -------------------------------------------------------------- catalog

    def models(self) -> List[CatalogModel]:
        """``GET /v1/models``, projected without loss."""
        data, _ = self.request("GET", "/v1/models")
        entries = (data or {}).get("data") or []
        return [to_catalog_model(entry) for entry in entries]

    def model(self, model_id: str) -> CatalogModel:
        """One catalog entry, or a 404 that cannot tell you whether it exists."""
        from urllib.parse import quote

        data, _ = self.request("GET", f"/v1/models/{quote(model_id, safe='')}")
        return to_catalog_model(data or {})

    def balance(self) -> Balance:
        """Remaining spendable credit. A read; it never moves money."""
        data, _ = self.request("GET", "/v1/balance")
        payload = data or {}
        remaining = int(payload.get("remaining_nanodollars") or 0)
        return Balance(
            remaining_nano_usd=remaining,
            remaining_usd=nano_usd_to_usd_string(remaining),
            included_nano_usd=payload.get("included_nanodollars"),
            allowance_remaining_nano_usd=payload.get("allowance_remaining_nanodollars"),
            credits_remaining_nano_usd=payload.get("credits_remaining_nanodollars"),
        )

    def cheapest_for(
        self, caps: Sequence[str] = (), min_context_window: Optional[int] = None
    ) -> Optional[CatalogModel]:
        """Cheapest catalog entry DECLARING every capability asked for."""
        return pick_cheapest(self.models(), caps, min_context_window)


# --------------------------------------------------------------- pure helpers


def resolve_chain(request: ChatRequest) -> List[str]:
    """The ordered model chain for one logical turn."""
    fallbacks = request.fallback_models or []
    if not fallbacks:
        return [request.model]
    if not request.allow_client_fallback:
        raise ConiferPortabilityError(
            "fallback_models",
            "Conifer's gateway admits exactly the model you name, so a fallback list is a "
            "CLIENT-SIDE chain of separate billed requests. Set allow_client_fallback=True "
            "to accept that, or drop the list.",
        )
    return [request.model, *fallbacks]


def chat_body(request: ChatRequest, stream: bool = False) -> Dict[str, Any]:
    """The JSON body, from the card's body-mapped fields only."""
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
        # Always ask for the terminal usage chunk: a streamed turn that cannot
        # report its own tokens is a turn the caller cannot reconcile.
        body["stream_options"] = {"include_usage": True}
    body.update(request.extra_body)
    return body


def chat_headers(request: ChatRequest, idempotency_key: str) -> Dict[str, str]:
    """The header set, from the card's header-mapped fields only."""
    headers = dict(request.headers)
    headers["idempotency-key"] = idempotency_key
    if request.max_cost_nano_usd is not None:
        if not isinstance(request.max_cost_nano_usd, int) or isinstance(
            request.max_cost_nano_usd, bool
        ):
            raise ConiferPortabilityError(
                "max_cost_nano_usd",
                "the cost ceiling is an INTEGER nanodollar amount ($1 = 1e9). A fractional "
                "value is refused rather than rounded, because rounding a spend limit is "
                "the wrong direction half the time.",
            )
        headers["x-conifer-max-cost-nanousd"] = str(request.max_cost_nano_usd)
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
    return headers


def to_catalog_model(entry: Mapping[str, Any]) -> CatalogModel:
    """Parse a catalog entry, keeping the raw dict so nothing is lost."""
    return CatalogModel(
        id=str(entry.get("id", "")),
        endpoint_kind=entry.get("endpoint_kind"),
        display_name=entry.get("display_name"),
        provider=entry.get("provider"),
        context_window=entry.get("context_window"),
        max_output_tokens=entry.get("max_output_tokens"),
        max_tools=entry.get("max_tools"),
        caps=entry.get("caps"),
        pricing=entry.get("pricing"),
        fee_pct=entry.get("fee_pct"),
        unavailable=entry.get("unavailable"),
        raw=dict(entry),
    )


def price_of(model: CatalogModel) -> Optional[float]:
    """A comparable ranking number per model, in USD per million tokens.

    The catalog states prices as DECIMAL STRINGS ("10", "12.5"), not numbers —
    they are money, and a string survives the JSON round-trip a float would
    quietly perturb. Parsing them is not a detail: the first version of this
    summed only numeric values and so ranked the entire live catalog as
    unpriced, making ``cheapest_for`` return nothing at all.

    Input and output are weighted rather than every field summed, because a
    flat sum lets a model with cheap input and ruinous output outrank one that
    is cheaper for any real turn. The 3:1 weighting is a ranking convention,
    NOT a cost forecast — ``receipt.cost_nano_usd`` is the only authority on
    what a turn actually cost. Cache rates are excluded: whether they apply is
    a property of the conversation, not of the model.
    """
    if not model.pricing:
        return None
    input_rate = _decimal(model.pricing.get("in_usd_per_mtok"))
    output_rate = _decimal(model.pricing.get("out_usd_per_mtok"))
    if input_rate is None and output_rate is None:
        # An unrecognized pricing shape is UNPRICED, not free.
        return None
    return (input_rate or 0.0) + 3 * (output_rate or 0.0)


def _decimal(value: Any) -> Optional[float]:
    """A catalog money value: a decimal string, or a number if one appears."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def pick_cheapest(
    models: Sequence[CatalogModel],
    caps: Sequence[str] = (),
    min_context_window: Optional[int] = None,
) -> Optional[CatalogModel]:
    """Cheapest DECLARED-capable model.

    Undeclared caps are UNKNOWN, not "yes", so such a model is skipped rather
    than assumed capable; an unpriced model is skipped rather than assumed free.
    """
    eligible = []
    for model in models:
        if model.unavailable:
            continue
        if min_context_window is not None:
            if model.context_window is None or model.context_window < min_context_window:
                continue
        if caps:
            if model.caps is None or not all(cap in model.caps for cap in caps):
                continue
        if price_of(model) is None:
            continue
        eligible.append(model)
    if not eligible:
        return None
    return min(eligible, key=lambda m: price_of(m) or 0)


def parse_frame(frame: str) -> Optional[Dict[str, Any]]:
    """One SSE line -> one chunk. ``[DONE]``, comments and blanks yield None."""
    line = frame.strip()
    if not line.startswith("data:"):
        return None
    data = line[5:].strip()
    if data == "" or data == "[DONE]":
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def backoff_seconds(attempt: int) -> float:
    """Exponential backoff with jitter: 0.25s, 0.5s, 1s, …"""
    return 0.25 * (2**attempt) + random.random() * 0.1


def _parse_json(text: str, status: int) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": {"type": f"http_{status}", "message": text[:500]}}
