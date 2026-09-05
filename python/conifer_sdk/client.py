"""The Conifer client. Standard library only; the wire shapes live in chat.py,
embeddings.py, catalog.py and jobs.py, and the network in transport.py."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import quote, urlparse

from .catalog import pick_cheapest, price_of, to_catalog_model  # noqa: F401  (re-exported)
from .chat import (  # noqa: F401  (re-exported)
    MAX_SERVER_FALLBACK_MODELS,
    chat_body,
    chat_headers,
    resolve_chain,
    server_fallback_header,
    turn_identity,
    with_cost,
)
from .embeddings import decode_vector, embeddings_body, embeddings_headers  # noqa: F401
from .errors import (
    ConiferCapabilityError,
    ConiferConflictError,
    ConiferConnectionError,
    ConiferError,
    ConiferPortabilityError,
    ConiferTimeoutError,
    error_from,
)
from .jobs import parse_frame, to_deferred_job  # noqa: F401  (re-exported)
from .jobs import decode_frame, iter_frames
from .receipt import Receipt, nano_usd_to_usd_string, read_receipt
from .transport import (  # noqa: F401  (re-exported)
    RETRYABLE_STATUS,
    USER_AGENT,
    Transport,
    backoff_seconds,
    is_cert_failure,
    minimum_backoff_seconds,
    parse_json,
    ssl_context,
    urllib_transport,
    with_user_agent,
)
from .types import (
    Balance,
    CatalogModel,
    ChatRequest,
    Completion,
    DeferredJob,
    Embedding,
    EmbeddingsRequest,
    EmbeddingsResponse,
    RouteDecision,
    RouteRequest,
    is_terminal_job,
)

DEFAULT_BASE_URL = "https://api.conifer.build"
#: Matches the gateway's own edge cut, so the client never quits on a live turn.
DEFAULT_TIMEOUT_SECONDS = 300.0
#: The gateway refuses a deferred completion window shorter than 24 hours.
MIN_DEFER_WINDOW_SECONDS = 86_400


def resolve_base_url(explicit: Optional[str], env: Mapping[str, str]) -> str:
    """The gateway origin. ``CONIFER_BASE_URL`` wins; ``OPENAI_BASE_URL`` is
    honoured only when it uses HTTPS on a Conifer host."""
    chosen = explicit or env.get("CONIFER_BASE_URL")
    if chosen is None:
        candidate = env.get("OPENAI_BASE_URL")
        if candidate is not None and _is_conifer_host(candidate):
            chosen = candidate
    chosen = (chosen or DEFAULT_BASE_URL).rstrip("/")
    return chosen[:-3] if chosen.endswith("/v1") else chosen


def _is_conifer_host(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = parsed.hostname
    except ValueError:
        return False
    return parsed.scheme == "https" and host is not None and (
        host == "conifer.build" or host.endswith(".conifer.build")
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
        self._transport: Transport = transport or urllib_transport
        #: The routing receipt of the most recent :meth:`stream`. Cost fields are absent on a stream.
        self.stream_receipt: Optional[Receipt] = None

    # ------------------------------------------------------------- transport

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Tuple[Any, Dict[str, str]]:
        """One request. Retries transport faults and retryable statuses with the same idempotency key."""
        url = f"{self.base_url}{path}"
        merged = with_user_agent(self.default_headers, headers or {})
        merged["authorization"] = f"Bearer {self.api_key}"
        merged["accept"] = "application/json"
        payload: Optional[bytes] = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            merged["content-type"] = "application/json"

        last: Optional[ConiferError] = None
        for attempt in range(self.max_retries + 1):
            try:
                status, response_headers, text = self._transport(method, url, merged, payload, self.timeout)
            except TimeoutError as cause:
                last = ConiferTimeoutError(
                    f"no response within {self.timeout}s; the turn may still have been served and billed"
                )
                if attempt < self.max_retries:
                    time.sleep(backoff_seconds(attempt))
                    continue
                raise last from cause
            except OSError as cause:
                if is_cert_failure(cause):
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

            parsed = parse_json(text, status)
            if 200 <= status < 300:
                return parsed, response_headers

            failure = error_from(status, parsed, response_headers)
            if failure.retryable and status in RETRYABLE_STATUS and attempt < self.max_retries:
                hinted = getattr(failure, "retry_after_seconds", None)
                time.sleep(
                    max(0, min(hinted, self.timeout)) if hinted is not None
                    else max(backoff_seconds(attempt), minimum_backoff_seconds(status))
                )
                last = failure
                continue
            raise failure

        raise last or ConiferConnectionError("request loop exhausted")

    # ------------------------------------------------------------------ chat

    def chat(self, request: ChatRequest) -> Completion:
        """One chat turn, with the exact settled cost in ``receipt``."""
        if request.defer:
            raise ConiferPortabilityError(
                "defer",
                "a deferred turn returns a job, not a completion. Call defer() for the job, "
                "then jobs_wait(job.job_id) to collect it.",
            )
        chain = resolve_chain(request)
        idempotency_key = turn_identity(request)
        last: Optional[ConiferError] = None

        for index, model in enumerate(chain):
            member = ChatRequest(**{**request.__dict__, "model": model})
            key = idempotency_key if index == 0 else f"{idempotency_key}-{index}"
            try:
                data, headers = self.request("POST", "/v1/chat/completions", chat_body(member), chat_headers(member, key))
            except ConiferError as error:
                last = error
                # A different model can also resolve a capability refusal.
                # Auth, payment, and other bad requests fail on every member.
                advances = error.retryable or isinstance(error, ConiferCapabilityError)
                if not advances or index == len(chain) - 1:
                    raise
                continue
            return _completion(data, read_receipt(headers), index)

        raise last or ConiferError(status=0, type="empty_chain", message="no model to call")

    def stream(self, request: ChatRequest) -> Iterator[Dict[str, Any]]:
        """Stream one turn, yielding raw chunks. The routing receipt is in
        :attr:`stream_receipt`; the cost is in the final ``usage`` chunk."""
        if request.fallback_models:
            raise ConiferPortabilityError(
                "fallback_models+stream",
                "a client-side fallback chain cannot be applied to a stream: the first "
                "token commits the turn. Call chat() for a chain.",
            )
        headers = chat_headers(request, turn_identity(request))
        headers["accept"] = "text/event-stream"
        response = self._open_stream(chat_body(request, stream=True), headers)
        self.stream_receipt = read_receipt(response.headers)
        try:
            for frame in iter_frames(response):
                chunk = decode_frame(frame)
                if chunk == "[DONE]":
                    return
                if chunk is None:
                    continue
                if chunk.get("error") is not None and "choices" not in chunk:
                    raise error_from(response.status, chunk, {k.lower(): v for k, v in response.headers.items()})
                yield chunk
        finally:
            response.close()

    def _open_stream(self, body: Dict[str, Any], headers: Dict[str, str]) -> Any:
        """The raw SSE response. Not retried and not buffered."""
        merged = with_user_agent(self.default_headers, headers)
        merged["authorization"] = f"Bearer {self.api_key}"
        merged["content-type"] = "application/json"
        url = f"{self.base_url}/v1/chat/completions"
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=merged, method="POST")
        try:
            return urllib.request.urlopen(req, timeout=self.timeout, context=ssl_context())
        except urllib.error.HTTPError as error:
            raise error_from(
                error.code,
                parse_json(error.read().decode("utf-8"), error.code),
                {k.lower(): v for k, v in (error.headers or {}).items()},
            ) from error

    # -------------------------------------------------------- deferred jobs

    def defer(self, request: ChatRequest) -> DeferredJob:
        """Submit a turn as a deferred job. Accepted and debited now; collect it with :meth:`jobs_wait`."""
        if request.server_fallback_models:
            raise ConiferPortabilityError(
                "server_fallback_models+defer",
                "a fallback chain cannot ride a deferred job: its outcome is not known "
                "until it ends. Submit one job and handle a `failed` status.",
            )
        if request.fallback_models:
            raise ConiferPortabilityError(
                "fallback_models+defer",
                "a client-side fallback chain cannot be applied to a deferred job: its "
                "outcome is not known until it ends. Submit one job and handle a `failed` status.",
            )
        deferred = ChatRequest(
            **{
                **request.__dict__,
                "defer": True,
                "deadline_seconds": request.deadline_seconds or MIN_DEFER_WINDOW_SECONDS,
            }
        )
        data, _ = self.request("POST", "/v1/chat/completions", chat_body(deferred), chat_headers(deferred, turn_identity(request)))
        return to_deferred_job(data or {})

    def job_status(self, job_id: str) -> DeferredJob:
        """``GET /v1/deferred/{id}``: status only. A 404 never means "not yet"."""
        data, _ = self.request("GET", f"/v1/deferred/{quote(job_id, safe='')}")
        return to_deferred_job(data or {})

    def job_result(self, job_id: str) -> Completion:
        """The completion with its receipt. Raises :class:`ConiferConflictError`
        while the job runs and for terminal states with no result."""
        data, headers = self.request("GET", f"/v1/deferred/{quote(job_id, safe='')}/result")
        return _completion(data, read_receipt(headers), 0)

    def job_cancel(self, job_id: str) -> DeferredJob:
        """``POST /v1/deferred/{id}/cancel``. Unfinished work is refunded."""
        data, _ = self.request("POST", f"/v1/deferred/{quote(job_id, safe='')}/cancel")
        return to_deferred_job(data or {})

    def jobs_wait(
        self,
        job_id: str,
        poll_seconds: float = 2.0,
        max_poll_seconds: float = 30.0,
        timeout_seconds: Optional[float] = None,
        on_poll: Optional[Callable[[DeferredJob], None]] = None,
    ) -> Completion:
        """Poll with exponential backoff until the job ends, then return its
        result. Terminal states with no result raise. A timeout stops waiting
        but never cancels the job."""
        started = time.monotonic()
        interval = poll_seconds
        while True:
            job = self.job_status(job_id)
            if on_poll is not None:
                on_poll(job)
            if job.status in ("ended", "fetched"):
                return self.job_result(job_id)
            if is_terminal_job(job.status):
                raise ConiferConflictError(
                    status=409,
                    type="request_in_progress",
                    message=(
                        f'deferred job {job_id} ended as "{job.status}" and has no result. '
                        "Cancelled, failed and expired jobs are refunded for the unfinished work."
                    ),
                    body=job.raw,
                )
            if timeout_seconds is not None and time.monotonic() - started >= timeout_seconds:
                raise ConiferTimeoutError(
                    f'deferred job {job_id} was still "{job.status}" after {timeout_seconds}s. '
                    f'The job was NOT cancelled: job_result("{job_id}") will return it once it ends.'
                )
            time.sleep(interval)
            interval = min(interval * 2, max_poll_seconds)

    # --------------------------------------------------------------- catalog

    def models(self) -> List[CatalogModel]:
        """``GET /v1/models``: the catalog this key can call, with prices."""
        data, _ = self.request("GET", "/v1/models")
        return [to_catalog_model(entry) for entry in (data or {}).get("data") or []]

    def model(self, model_id: str) -> CatalogModel:
        """One catalog entry. A 404 does not say whether the id exists."""
        data, _ = self.request("GET", f"/v1/models/{quote(model_id, safe='')}")
        return to_catalog_model(data or {})

    def balance(self) -> Balance:
        """``GET /v1/balance``: remaining spendable credit. Never writes."""
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

    def cheapest_for(self, caps: Sequence[str] = (), min_context_window: Optional[int] = None) -> Optional[CatalogModel]:
        """The cheapest catalog model that declares every capability in ``caps``."""
        return pick_cheapest(self.models(), caps, min_context_window)

    def route(self, request: RouteRequest) -> RouteDecision:
        """``POST /v1/route``: the router's pick for a query, without the
        completion. Free. To route and complete in one call, send
        ``model="auto"`` to :meth:`chat` and read ``receipt.effective_model``.
        A 503 means the router did not answer."""
        data, _ = self.request("POST", "/v1/route", body=route_body(request))
        return to_route_decision(data or {})

    # ------------------------------------------------------------- embeddings

    def embed(self, request: EmbeddingsRequest) -> EmbeddingsResponse:
        """One embeddings call with its settled cost. Vectors are requested as
        base64 float32 and decoded to floats; pass ``encoding_format="float"``
        to receive JSON floats instead."""
        if isinstance(request.input, (list, tuple)) and any(not isinstance(item, str) for item in request.input):
            raise ConiferPortabilityError(
                "input",
                "embeddings input must be text (a string, or a list of strings). Token-id arrays are refused.",
            )
        data, headers = self.request(
            "POST", "/v1/embeddings", embeddings_body(request), embeddings_headers(request, turn_identity(request))
        )
        payload = data if isinstance(data, dict) else {}
        receipt = read_receipt(headers)
        return EmbeddingsResponse(
            data=[
                Embedding(
                    index=entry.get("index", position),
                    embedding=decode_vector(entry.get("embedding")),
                    object=entry.get("object"),
                )
                for position, entry in enumerate(payload.get("data") or [])
            ],
            receipt=receipt,
            model=payload.get("model"),
            object=payload.get("object"),
            usage=with_cost(payload.get("usage"), receipt),
            raw=payload,
        )


def _completion(data: Any, receipt: Receipt, fallback_index: int) -> Completion:
    payload = data if isinstance(data, dict) else {}
    return Completion(
        choices=payload.get("choices") or [],
        receipt=receipt,
        fallback_index=fallback_index,
        id=payload.get("id"),
        model=payload.get("model"),
        usage=with_cost(payload.get("usage"), receipt),
        raw=payload,
    )


# ----------------------------------------------------------------- routing


def route_body(request: RouteRequest) -> Dict[str, Any]:
    """The JSON body for ``POST /v1/route``."""
    body: Dict[str, Any] = {"query": request.query}
    if request.policy is not None:
        body["policy"] = request.policy
    if request.candidates is not None:
        body["candidates"] = list(request.candidates)
    if request.tools is not None:
        body["tools"] = request.tools
    if request.max_output_tokens is not None:
        body["max_output_tokens"] = request.max_output_tokens
    return body


def to_route_decision(data: Mapping[str, Any]) -> RouteDecision:
    """The decision: a pick, its fallbacks, the policy, and the router version."""
    return RouteDecision(
        model=str(data.get("model") or ""),
        fallbacks=[f for f in (data.get("fallbacks") or []) if isinstance(f, str)],
        policy=str(data.get("policy") or "balanced"),
        router_version=str(data.get("router_version") or ""),
        raw=dict(data),
    )
