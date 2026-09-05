"""Public request and response shapes. Every field maps to a real gateway
input or output."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .receipt import Receipt

Message = Dict[str, Any]


# ---------------------------------------------------------------------- chat


@dataclass
class ChatRequest:
    """One chat turn."""

    #: A catalog id, or ``auto`` / ``balanced`` / ``best`` to let the router pick.
    model: str
    messages: List[Message]
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    stop: Optional[Any] = None
    tools: Optional[List[Any]] = None
    tool_choice: Optional[Any] = None
    response_format: Optional[Any] = None
    reasoning: Optional[Dict[str, Any]] = None

    #: Hard ceiling on this call's cost, in integer nanodollars. Over it, the call is refused.
    max_cost_nano_usd: Optional[int] = None
    #: Advisory completion window in whole seconds.
    deadline_seconds: Optional[int] = None
    #: Submit as a deferred job. Use ``defer()``, which returns the job.
    defer: bool = False
    #: Hard venue constraint. The hosted gateway is ``cloud``.
    venue: Optional[str] = None
    #: ``"off"`` skips prompt-cache annotation for this turn.
    prompt_cache: Optional[str] = None

    idempotency_key: Optional[str] = None
    request_id: Optional[str] = None
    #: Your app's name, for your own usage attribution.
    client: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    #: Fields the SDK does not model, merged into the body.
    extra_body: Dict[str, Any] = field(default_factory=dict)

    #: Client-side chain: models to try in order, each as a separate billed
    #: request, when the primary fails retryably. Requires ``allow_client_fallback``.
    fallback_models: Optional[List[str]] = None
    allow_client_fallback: bool = False
    #: Server-side chain: models the gateway falls back to inside one request
    #: when the requested model's upstream call fails. One hold, one bill; a
    #: served fallback is disclosed in ``receipt.effective_model`` with reason
    #: ``provider_failover``. At most three. Not available with ``defer``.
    server_fallback_models: Optional[List[str]] = None


@dataclass
class Completion:
    """The OpenAI chat wire plus the settled receipt for this call."""

    choices: List[Dict[str, Any]]
    receipt: Receipt
    #: Which chain member served. 0 is the model you asked for.
    fallback_index: int
    id: Optional[str] = None
    model: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> Optional[str]:
        """The first choice's text content, or ``None``."""
        if not self.choices:
            return None
        content = (self.choices[0].get("message") or {}).get("content")
        return content if isinstance(content, str) else None

    @property
    def empty_reason(self) -> Optional[str]:
        """Why this completion has no text, as a sentence, or ``None`` when it
        has text or a tool call. The common cause is a reasoning model spending
        ``max_tokens`` on its thinking block before the visible answer."""
        if not self.choices:
            return (
                "the gateway returned no choices at all. If this was a deferred turn, use "
                "defer() and jobs_wait(); a 202 job envelope is not a completion."
            )
        choice = self.choices[0]
        message = choice.get("message") or {}
        content = message.get("content")
        if isinstance(content, str) and content != "":
            return None
        if message.get("tool_calls"):
            return None
        finish = choice.get("finish_reason")
        if finish == "length":
            details = (self.usage or {}).get("completion_tokens_details") or {}
            reasoning = details.get("reasoning_tokens")
            if isinstance(reasoning, int) and reasoning > 0:
                spent = (self.usage or {}).get("completion_tokens")
                return (
                    f"the model hit max_tokens while still reasoning ({reasoning} of {spent} "
                    "output tokens went to thinking), so it never reached the visible answer. "
                    "Raise max_tokens, or lower reasoning effort on a model that supports it."
                )
            return (
                "the model hit max_tokens before emitting visible text. On a reasoning model "
                "the thinking block is spent FIRST, so a small max_tokens can be used up "
                "before the answer starts. Raise max_tokens."
            )
        if finish == "content_filter":
            return (
                "the upstream provider's own content filter stopped this turn. Conifer "
                "applies no moderation of its own."
            )
        return f"the model returned empty content with finish_reason {finish!r}."


# ------------------------------------------------------------------- catalog


@dataclass
class CatalogModel:
    """One ``GET /v1/models`` entry. ``raw`` keeps every field."""

    id: str
    #: ``"conifer"`` (credits) or ``"byok"`` (your own key serves it).
    endpoint_kind: Optional[str] = None
    display_name: Optional[str] = None
    provider: Optional[str] = None
    context_window: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_tools: Optional[int] = None
    #: Declared capabilities. ``None`` means undeclared, not unsupported.
    caps: Optional[List[str]] = None
    #: Native vector width of an embedding model. ``dimensions`` on a request overrides it.
    embedding_dimensions: Optional[int] = None
    #: The as-charged price for this entry's lane.
    pricing: Optional[Dict[str, Any]] = None
    #: BYOK take rate as a percent.
    fee_pct: Optional[float] = None
    #: True when BYOK custody is degraded for a provider you hold a key for.
    unavailable: Optional[bool] = None
    raw: Dict[str, Any] = field(default_factory=dict)
    #: Declared minimum completion budget, including reasoning tokens.
    min_output_tokens: Optional[int] = None
    #: False means completions are refused before spend. None means undeclared.
    output_token_limit_supported: Optional[bool] = None


@dataclass
class Balance:
    """Remaining spendable credit."""

    remaining_nano_usd: int
    remaining_usd: str
    included_nano_usd: Optional[int] = None
    allowance_remaining_nano_usd: Optional[int] = None
    credits_remaining_nano_usd: Optional[int] = None


# ------------------------------------------------------------------- routing

#: The routing policies the gateway serves. They double as model ids:
#: ``chat(model="auto")`` runs ``balanced``. ``cost-effective`` and ``fast``
#: exist in the router but are muted on the gateway; the virtual rows of
#: ``models()`` are the authority for what a given gateway serves.
ROUTE_POLICIES = ("balanced", "best")


@dataclass
class RouteRequest:
    """One routing decision."""

    #: The current ask: the last user message.
    query: str
    #: Defaults to ``balanced``.
    policy: Optional[str] = None
    #: Restrict the field to these catalog ids. Intersected with your own listing.
    candidates: Optional[List[str]] = None
    #: The turn will carry tool schemas.
    tools: Optional[bool] = None
    #: The completion cap the turn will run under.
    max_output_tokens: Optional[int] = None


@dataclass
class RouteDecision:
    """The router's decision: a pick and fallbacks, never a score."""

    #: A catalog id you can call.
    model: str
    #: The router's next picks, in order. At most three.
    fallbacks: List[str]
    policy: str
    #: The router artifact that produced this decision.
    router_version: str
    raw: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------- embeddings


@dataclass
class EmbeddingsRequest:
    """One embeddings call. Billed on input only, so there are no sampling fields."""

    #: A model whose ``caps`` include ``embeddings``.
    model: str
    #: Text or a list of texts. Token-id arrays are refused.
    input: Any
    #: Matryoshka shortening, where the model supports it.
    dimensions: Optional[int] = None
    #: Wire encoding. Defaults to ``base64``, which the SDK decodes to floats.
    encoding_format: Optional[str] = None
    #: Opaque end-user id, forwarded verbatim.
    user: Optional[str] = None

    #: Hard ceiling on this call's cost, in integer nanodollars.
    max_cost_nano_usd: Optional[int] = None
    idempotency_key: Optional[str] = None
    request_id: Optional[str] = None
    #: Your app's name, for your own usage attribution.
    client: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    #: Fields the SDK does not model, merged into the body.
    extra_body: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Embedding:
    """One vector, as floats whatever the wire encoding was."""

    index: int
    embedding: List[float]
    object: Optional[str] = None


@dataclass
class EmbeddingsResponse:
    """One embeddings call's result with its settled cost."""

    data: List[Embedding]
    receipt: Receipt
    model: Optional[str] = None
    object: Optional[str] = None
    #: Input tokens only.
    usage: Optional[Dict[str, Any]] = None
    #: The provider's own body, untouched.
    raw: Dict[str, Any] = field(default_factory=dict)


def vector_of(response: EmbeddingsResponse) -> Optional[List[float]]:
    """The first vector, for the single-input call."""
    return response.data[0].embedding if response.data else None


# ------------------------------------------------------------- deferred jobs

#: States a job never leaves. ``ended`` and ``fetched`` were charged and have a
#: result; ``expired``, ``cancelled`` and ``failed`` refund the unfinished work.
TERMINAL_JOB_STATUSES = ("fetched", "expired", "cancelled", "failed")


def is_terminal_job(status: Optional[str]) -> bool:
    return status in TERMINAL_JOB_STATUSES


@dataclass
class DeferredJob:
    """A deferred job as returned by the 202 accept and every status poll. No content, no cost."""

    job_id: str
    #: queued / submitted / ended / fetched / expired / cancelled / failed.
    status: str
    #: Unix seconds. After this the job expires.
    deadline_utc: Optional[int] = None
    created_utc: Optional[int] = None
    model: Optional[str] = None
    #: The gateway's poll path, relative to the base URL.
    poll_url: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)
