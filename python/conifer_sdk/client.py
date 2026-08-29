"""The Python client. Twin of src/client.ts, standard library only.

The transport is ``urllib`` behind an injectable ``transport`` callable, so
tests drive real request bytes without a network and without a mock framework.
"""

from __future__ import annotations

import base64
import json
import os
import random
import struct
import time
import ssl
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple

from . import __version__  # noqa: E402  (single source: __init__)
from .errors import (
    ConiferConflictError,
    ConiferConnectionError,
    ConiferError,
    ConiferPortabilityError,
    ConiferTimeoutError,
    error_from,
)
from .receipt import Receipt, nano_usd_to_usd_string, read_receipt
from .types import (
    Balance,
    DeferredJob,
    CatalogModel,
    ChatRequest,
    Completion,
    Embedding,
    EmbeddingsRequest,
    EmbeddingsResponse,
    is_terminal_job,
)

DEFAULT_BASE_URL = "https://api.conifer.build"
#: Matches the gateway's own 300s edge silent-cut, so the client never gives up
#: on a turn the gateway is still serving (and still going to bill).
DEFAULT_TIMEOUT_SECONDS = 300.0
#: The narrowest completion window the gateway accepts a deferred job for.
#:
#: Not a client-side convention: the gateway refuses anything smaller with
#: "defer requires a completion window of at least 86400 seconds" (measured
#: live 2026-08-27). Deferred work rides a provider batch, and a batch cannot
#: promise a short turnaround — so a narrow window is refused rather than
#: quietly served synchronously at a different price.
MIN_DEFER_WINDOW_SECONDS = 86_400

#: Statuses a retry can plausibly fix.
#:
#: 409 is here for ONE narrow reason, and only in combination with the error's
#: own ``retryable``: the gateway authors two 409s that literally say "retry
#: shortly" (a first attempt still in flight, or a settled body cached on
#: another replica). Those are the gateway asking to be asked again, and asking
#: again is safe precisely because the retry carries the SAME idempotency key —
#: so it either replays the settled response or waits its turn, but cannot bill
#: twice. The third 409, "already used with a different request body", is
#: terminal and ConiferConflictError marks it non-retryable, so it never
#: reaches this set's permission.
_RETRYABLE_STATUS = {409, 429, 502, 503, 504}

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


#: The User-Agent every request carries unless the caller overrides it via
#: ``default_headers``. Python's own default ("Python-urllib/3.x") is on
#: Cloudflare's stock browser-signature ban list, and on 2026-08-29 the
#: api.conifer.build zone served every such request a 1010 "browser signature
#: banned" 403 before it reached the gateway — an SDK that is indistinguishable
#: from generic urllib traffic inherits every edge rule aimed at scrapers.
#: Naming ourselves is both the fix and honest telemetry.
USER_AGENT = f"conifer-sdk-python/{__version__}"


def _with_user_agent(*header_maps: Mapping[str, str]) -> Dict[str, str]:
    """Merge header maps over the SDK's default User-Agent, case-insensitively.

    HTTP header names are case-insensitive but ``dict`` keys are not, and
    urllib sends every entry: seeding ``{"user-agent": ...}`` and updating with
    a caller's ``{"User-Agent": ...}`` would keep BOTH spellings and emit a
    duplicated header (Greptile P1 on the PR that added the UA). So the
    default is applied only when NO map, under ANY casing, already names one.
    """
    merged: Dict[str, str] = {}
    for headers in header_maps:
        merged.update(headers)
    if not any(key.lower() == "user-agent" for key in merged):
        merged["user-agent"] = USER_AGENT
    return merged


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
        merged = _with_user_agent(self.default_headers, headers or {})
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
                time.sleep(
                    hinted
                    if hinted is not None
                    else max(backoff_seconds(attempt), minimum_backoff_seconds(status))
                )
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
        first without the caller seeing the seam. That is the CLIENT chain
        (``fallback_models``). ``server_fallback_models`` is unaffected and
        works here: the gateway fails over BEFORE the first frame, so no seam
        is ever stitched into a stream the caller is already reading.
        """
        if request.fallback_models:
            raise ConiferPortabilityError(
                "fallback_models+stream",
                "a client-side fallback chain cannot be applied to a stream: the first "
                "token commits the turn. Call chat() for a chain, or handle the failure "
                "and re-stream yourself.",
            )
        key = turn_identity(request)
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
        merged = _with_user_agent(self.default_headers, headers)
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
        if request.defer:
            # A deferred turn answers 202 with a JOB ENVELOPE, not a
            # completion. Coercing it into Completion is exactly what this SDK
            # used to do, and the result was a turn that had been ACCEPTED AND
            # DEBITED coming back as choices=[] — indistinguishable, at the
            # call site, from a model that answered with nothing.
            raise ConiferPortabilityError(
                "defer",
                "a deferred turn is accepted with 202 and a job id, not a completion \u2014 "
                "chat() has nothing to return. Call defer() for the job, then "
                "jobs_wait(job.job_id) (or job_status/job_result) to collect it.",
            )
        chain = resolve_chain(request)
        idempotency_key = turn_identity(request)
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
                usage=with_cost(payload.get("usage"), read_receipt(headers)),
                raw=payload,
            )

        raise last or ConiferError(status=0, type="empty_chain", message="no model to call")

    # -------------------------------------------------------- deferred jobs

    def defer(self, request: ChatRequest) -> DeferredJob:
        """Submit a turn as a DEFERRED JOB, and get the job back.

        The trade is explicit: you give up an immediate answer, and in exchange
        the turn rides a provider batch. It is the right shape for work that is
        not interactive — an overnight re-index, a bulk classification, an eval
        sweep.

        The gateway requires a completion window of at least 24 hours and
        refuses a narrower one rather than quietly serving it synchronously, so
        that floor is the default here and the common call just works.

        The job is ACCEPTED AND DEBITED at submission. Collect it with
        :meth:`jobs_wait`, or poll :meth:`job_status` and call
        :meth:`job_result` yourself.
        """
        if request.server_fallback_models:
            # The gateway refuses this pair too; saying so here keeps the
            # caller from believing a submitted job is protected by a chain.
            raise ConiferPortabilityError(
                "server_fallback_models+defer",
                "a fallback chain cannot ride a deferred job: the outcome is not known "
                "until the job ends, by which time falling back would mean submitting a "
                "second job you never asked for. Submit one job and handle a `failed` "
                "status.",
            )
        if request.fallback_models:
            # A chain is a sequence of SEPARATE requests decided by watching
            # the first one fail. A deferred job's failure is discovered hours
            # later, by which time "fall back" would mean submitting a second
            # job the caller never asked for.
            raise ConiferPortabilityError(
                "fallback_models+defer",
                "a client-side fallback chain cannot be applied to a deferred job: the "
                "outcome is not known until the job ends. Submit one job, and handle a "
                "`failed` status yourself.",
            )
        deferred = ChatRequest(
            **{
                **request.__dict__,
                "defer": True,
                "deadline_seconds": request.deadline_seconds or MIN_DEFER_WINDOW_SECONDS,
            }
        )
        data, _ = self.request(
            "POST",
            "/v1/chat/completions",
            chat_body(deferred),
            chat_headers(deferred, turn_identity(request)),
        )
        return to_deferred_job(data or {})

    def job_status(self, job_id: str) -> DeferredJob:
        """``GET /v1/deferred/{id}``. Status only; no content, no cost.

        TENANCY: a job id belonging to another account and one that never
        existed are the SAME 404 — an existence oracle would leak other
        people's traffic — so a 404 means "not yours or not real", never
        "not yet".
        """
        from urllib.parse import quote

        data, _ = self.request("GET", f"/v1/deferred/{quote(job_id, safe='')}")
        return to_deferred_job(data or {})

    def job_result(self, job_id: str) -> Completion:
        """The completion, with its settled receipt.

        Raises :class:`ConiferConflictError` while the job is still running,
        and ALSO for every terminal state that has no result (cancelled,
        failed, expired). The message says which, because the money differs: a
        failed or expired job was refunded, while a result that aged out
        unfetched was charged and is gone.

        Fetching is not free of consequence: it moves the job to ``fetched``
        and starts the retention grace, after which the body is deleted.
        """
        from urllib.parse import quote

        data, headers = self.request("GET", f"/v1/deferred/{quote(job_id, safe='')}/result")
        payload = data if isinstance(data, dict) else {}
        return Completion(
            choices=payload.get("choices") or [],
            receipt=read_receipt(headers),
            fallback_index=0,
            id=payload.get("id"),
            model=payload.get("model"),
            # A deferred result settles in band too; same bridge. See with_cost.
            usage=with_cost(payload.get("usage"), read_receipt(headers)),
            raw=payload,
        )

    def job_cancel(self, job_id: str) -> DeferredJob:
        """Cancel a job. Refunded per the gateway's cancel rules."""
        from urllib.parse import quote

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
        """Poll until the job ends, then return its result.

        Written here so every caller does not re-derive the same three rules
        and get one of them wrong:

        1. STOP ON TERMINAL. ``expired``, ``cancelled`` and ``failed`` never
           change, so polling one forever is a loop that cannot exit. Those
           raise rather than spin.
        2. BACK OFF. A deferred job's whole premise is a long window (the
           gateway requires at least 24h), so a tight poll is thousands of
           pointless requests. The interval doubles up to ``max_poll_seconds``.
        3. RESPECT THE CALLER'S DEADLINE, without touching the job.

        This does NOT cancel on timeout. Cancelling work the caller paid for
        because a client-side clock ran out is not a decision an SDK should
        make silently; call :meth:`job_cancel` if that is what you want.
        """
        started = time.monotonic()
        interval = poll_seconds
        while True:
            job = self.job_status(job_id)
            if on_poll is not None:
                on_poll(job)
            if job.status in ("ended", "fetched"):
                return self.job_result(job_id)
            if is_terminal_job(job.status):
                # Terminal and resultless. Raising with the gateway's own
                # vocabulary beats returning an empty completion.
                raise ConiferConflictError(
                    status=409,
                    type="request_in_progress",
                    message=(
                        f'deferred job {job_id} ended as "{job.status}" and has no result. '
                        "Cancelled, failed and expired jobs are refunded for the "
                        "unfinished work."
                    ),
                    body=job.raw,
                )
            if timeout_seconds is not None and time.monotonic() - started >= timeout_seconds:
                raise ConiferTimeoutError(
                    f'deferred job {job_id} was still "{job.status}" after '
                    f"{timeout_seconds}s. The job was NOT cancelled: it is still running, "
                    f'and job_result("{job_id}") will return it once it ends.'
                )
            time.sleep(interval)
            interval = min(interval * 2, max_poll_seconds)

    # --------------------------------------------------------------- catalog

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

    # ------------------------------------------------------------- embeddings

    def embed(self, request: EmbeddingsRequest) -> EmbeddingsResponse:
        """One embeddings turn, with the exact settled cost of that call.

        BASE64 BY DEFAULT, DECODED FOR YOU. Unless you ask otherwise, the SDK
        requests ``encoding_format: "base64"`` and decodes the result into
        plain floats. This is not a micro-optimization: a JSON float array
        spends ~20 bytes per dimension and the same vector in base64 float32
        spends 5.33 — roughly a 3x smaller response, which on a 3072-dimension
        model batched 100 deep is the difference between ~6 MB and ~1.6 MB.

        Doing it silently is safe ONLY because the transformation is exactly
        lossless, which was verified against the live gateway rather than
        assumed: ``text-embedding-3-small`` returned the identical 1536 values
        both ways, max absolute difference 0.0. (The official OpenAI Python SDK
        makes the same call for the same reason.)

        Pass ``encoding_format="float"`` to send JSON floats instead. Either
        way, :attr:`EmbeddingsResponse.raw` holds the provider's own body.
        """
        # Refuse client-side rather than spend a turn discovering it. The
        # gateway refuses token-id input too, but only AFTER admission.
        if isinstance(request.input, (list, tuple)) and any(
            not isinstance(item, str) for item in request.input
        ):
            raise ConiferPortabilityError(
                "input",
                "embeddings input must be text (a string, or a list of strings). Token-id "
                "arrays are refused: the gateway cannot size a spend hold from token ids it "
                "did not tokenize.",
            )
        key = turn_identity(request)
        data, headers = self.request(
            "POST",
            "/v1/embeddings",
            embeddings_body(request),
            embeddings_headers(request, key),
        )
        payload = data if isinstance(data, dict) else {}
        entries = payload.get("data") or []
        return EmbeddingsResponse(
            data=[
                Embedding(
                    index=entry.get("index", position),
                    embedding=decode_vector(entry.get("embedding")),
                    object=entry.get("object"),
                )
                for position, entry in enumerate(entries)
            ],
            receipt=read_receipt(headers),
            model=payload.get("model"),
            object=payload.get("object"),
            usage=with_cost(payload.get("usage"), read_receipt(headers)),
            raw=payload,
        )


# --------------------------------------------------------------- pure helpers


#: The gateway's cap on a caller-directed fallback chain. Mirrored here so the
#: refusal happens at the call site; the gateway enforces it regardless.
MAX_SERVER_FALLBACK_MODELS = 3


def server_fallback_header(models: List[str], primary: str) -> Optional[str]:
    """``server_fallback_models`` -> the ``x-conifer-fallback-models`` value.

    Mirrors the GATEWAY's own admission rules, so the SDK never refuses a
    chain the gateway would have served, and never sends one it would reject:

    - a malformed member (blank, comma-bearing, non-ASCII) RAISES: it cannot
      survive the header intact, so sending it would arm nothing;
    - a duplicate, or the requested model itself, is DROPPED — the gateway
      treats these as harmless rather than wrong, and refusing here would make
      the SDK stricter than the wire;
    - the 3-member cap is checked AFTER that de-duplication, as the gateway
      counts it;
    - ``None`` when nothing survives, so the caller omits the header rather
      than sending an empty one.

    What is never done quietly is dropping a member that WOULD have changed
    the outcome: an unknown model still refuses, at the gateway, by name.
    """
    trimmed = [m.strip() for m in models]
    if any(m == "" for m in trimmed):
        raise ConiferPortabilityError(
            "server_fallback_models",
            "a fallback member is empty. The gateway refuses an empty entry rather than "
            "guessing what was meant; drop it, or drop the field entirely if you do not "
            "want fallbacks.",
        )
    for m in trimmed:
        # A comma is the header's separator, so a member containing one could
        # not survive the wire intact.
        if "," in m or not m.isascii() or not m.isprintable():
            raise ConiferPortabilityError(
                "server_fallback_models",
                f"`{m}` is not a usable model id here: the header is a comma-separated "
                "ASCII list, so a member carrying a comma or a non-ASCII byte cannot be "
                "sent unambiguously.",
            )
    # De-duplicate and drop the primary, as the gateway does, THEN apply the
    # cap — a list of three distinct survivors is legal however it was spelled.
    chain: List[str] = []
    for model in trimmed:
        if model == primary.strip() or model in chain:
            continue
        chain.append(model)
    if len(chain) > MAX_SERVER_FALLBACK_MODELS:
        raise ConiferPortabilityError(
            "server_fallback_models",
            f"at most {MAX_SERVER_FALLBACK_MODELS} fallback models are accepted per "
            "request; the gateway refuses a longer chain rather than silently trimming it.",
        )
    return ",".join(chain) if chain else None


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
        # Sent too, so a proxy or log shipper between you and the gateway still
        # sees the id. The GATEWAY itself reads `idempotency-key` first (see
        # turn_identity), which is why request_id now feeds that key as well.
        headers["x-request-id"] = request.request_id
    if request.client is not None:
        headers["x-conifer-client"] = request.client
    if request.server_fallback_models is not None:
        # Validated here rather than shipped and refused remotely, so the
        # mistake surfaces at the call site with its reason attached — and
        # never as a chain the caller believes is armed.
        chain = server_fallback_header(request.server_fallback_models, request.model)
        # Nothing survived de-duplication (e.g. the only member was the
        # requested model). Send no header rather than an empty one the
        # gateway would 400.
        if chain is not None:
            headers["x-conifer-fallback-models"] = chain
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
        embedding_dimensions=entry.get("embedding_dimensions"),
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


def to_deferred_job(payload: Mapping[str, Any]) -> DeferredJob:
    """The 202/status envelope, parsed."""
    return DeferredJob(
        job_id=str(payload.get("job_id", "")),
        status=str(payload.get("status", "")),
        deadline_utc=payload.get("deadline_utc"),
        created_utc=payload.get("created_utc"),
        model=payload.get("model"),
        poll_url=payload.get("poll_url"),
        raw=dict(payload),
    )


def turn_identity(request: Any) -> str:
    """The idempotency key for one logical turn.

    THE COLLAPSE (read the gateway's ``request_id()``, measured live
    2026-08-27). The gateway derives the request id from the FIRST of
    ``idempotency-key`` then ``x-request-id``. The SDK always sends an
    idempotency key, so ``x-request-id`` was never once consulted: a caller who
    set ``request_id`` to their own trace id got a generated ``idem-<uuid>``
    back in the receipt and had no way to correlate a support question with
    their own logs. The field was inert.

    So on this gateway the two ARE one identity, and the SDK stops pretending
    otherwise: an explicit ``request_id`` becomes the idempotency key, which
    makes the id you chose the id that comes back.

    The consequence is real and worth stating: the gateway binds an idempotency
    key to the request BODY, so reusing one ``request_id`` across two different
    bodies is a 409 ``request_in_progress`` rather than two turns. That is the
    correct answer to "the same request id for a different request", and it is
    loud rather than silent. Pass ``idempotency_key`` explicitly to control the
    two separately when your ids are not unique per turn.
    """
    return request.idempotency_key or request.request_id or f"idem-{uuid.uuid4()}"


def with_cost(usage: Optional[Dict[str, Any]], receipt: Receipt) -> Optional[Dict[str, Any]]:
    """Copy the settled cost from the receipt HEADERS onto ``usage`` in the BODY.

    WHY THIS IS WORTH DOING. Conifer discloses cost on ``x-conifer-cost-nanousd``,
    a response header. OpenRouter puts the same information in the response BODY
    as ``usage.cost``. That difference is invisible until it isn't: every logging
    pipeline, request recorder, LangChain/LiteLLM callback and JSON-dumping debug
    statement keeps the body and discards the headers. A team migrating from
    OpenRouter loses their cost column, and the fix is somewhere they are not
    looking.

    It matters more here than on other gateways: a normal caller's usage history
    is not readable back (``/admin/usage/*`` is owner-only), so the receipt on
    the turn is their ONLY record of what they spent.

    Two rules keep this honest:

    - ADDITIVE ONLY. If the gateway ever sends its own ``usage.cost``, that
      value wins; this never overwrites the server's number.
    - ABSENT STAYS ABSENT. On a stream the head carries no cost, so nothing is
      added — a ``cost`` of 0 would read as "this turn was free".

    The nanodollar integer is the authority and rides alongside as
    ``cost_nanousd``; ``cost`` is the decimal-USD float OpenRouter-shaped code
    already reads.
    """
    if receipt.cost_nano_usd is None:
        return usage
    existing = dict(usage or {})
    if existing.get("cost") is not None:
        return usage
    existing["cost"] = receipt.cost_nano_usd / 1_000_000_000
    existing["cost_nanousd"] = receipt.cost_nano_usd
    return existing


def backoff_seconds(attempt: int) -> float:
    """Exponential backoff with jitter: 0.25s, 0.5s, 1s, …"""
    return 0.25 * (2**attempt) + random.random() * 0.1


def minimum_backoff_seconds(status: int) -> float:
    """A floor on the wait for statuses whose recovery is not instant.

    The default schedule (0.25s, 0.5s) is tuned for a momentary blip and gives
    a retryable failure 0.75s of total patience. That is right for a 502 and
    far too impatient for a transient 409: those mean "a first attempt is in
    flight, or its settled body is on another replica", so the SDK is waiting
    for CROSS-REPLICA CONVERGENCE, not for a socket to come back.

    Found in a fresh-install consumer test — which is exactly where it would
    otherwise have been found, by a new user on their first call. The turn was
    being served; the client simply gave up after 0.75s and reported a hard
    failure for it. With this floor the same case gets ~4.5s across two
    retries, which covered every occurrence observed.

    Retrying remains safe because the retry carries the SAME idempotency key:
    the gateway either replays the settled response or serves the turn once.
    """
    return 1.5 if status == 409 else 0.0


# ------------------------------------------------------- embeddings helpers


def embeddings_body(request: EmbeddingsRequest) -> Dict[str, Any]:
    """The embeddings body. No sampling knobs: none of them mean anything."""
    body: Dict[str, Any] = {
        "model": request.model,
        "input": request.input,
        # See Conifer.embed for why base64 is the default and why it is safe.
        "encoding_format": request.encoding_format or "base64",
    }
    if request.dimensions is not None:
        body["dimensions"] = request.dimensions
    if request.user is not None:
        body["user"] = request.user
    body.update(request.extra_body)
    return body


def embeddings_headers(request: EmbeddingsRequest, idempotency_key: str) -> Dict[str, str]:
    """The embeddings headers. Same money ceiling and attribution as chat."""
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
    if request.request_id is not None:
        # Sent too, so a proxy or log shipper between you and the gateway still
        # sees the id. The GATEWAY itself reads `idempotency-key` first (see
        # turn_identity), which is why request_id now feeds that key as well.
        headers["x-request-id"] = request.request_id
    if request.client is not None:
        headers["x-conifer-client"] = request.client
    return headers


def decode_vector(value: Any) -> List[float]:
    """A vector as floats, from either wire encoding.

    The base64 arm is little-endian float32, which is what every provider on
    this door emits and what the OpenAI clients assume. Endianness is stated
    explicitly (``"<"``) rather than inherited from the host, so this decodes
    the same on a big-endian machine.

    An unrecognized shape yields an EMPTY vector rather than a guess. A wrong
    vector is far worse than an obviously missing one: it would sail through a
    cosine-similarity call and quietly return nonsense rankings forever.
    """
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    if not isinstance(value, str):
        return []
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        return []
    # float32 is 4 bytes; a length that is not a multiple of 4 is not a vector.
    if not raw or len(raw) % 4 != 0:
        return []
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _parse_json(text: str, status: int) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": {"type": f"http_{status}", "message": text[:500]}}
