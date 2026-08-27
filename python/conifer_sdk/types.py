"""Public shapes for the Python SDK — the same cards as the TypeScript twin."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .receipt import Receipt

Message = Dict[str, Any]


@dataclass
class ChatRequest:
    """One turn. Every field maps to a real gateway input (cards/sdk.input)."""

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

    #: HARD ceiling on the caller-total worst case, in integer nanodollars.
    max_cost_nano_usd: Optional[int] = None
    #: ADVISORY window in whole seconds. Widens HOW a turn is served, never what.
    deadline_seconds: Optional[int] = None
    #: Opt into the 202 deferred-job protocol. Refused loudly if unhonorable.
    defer: bool = False
    #: HARD venue constraint. This gateway is ``cloud``.
    venue: Optional[str] = None
    #: Only ``"off"`` is meaningful: skip prompt-cache annotation for this turn.
    prompt_cache: Optional[str] = None

    idempotency_key: Optional[str] = None
    request_id: Optional[str] = None
    client: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    extra_body: Dict[str, Any] = field(default_factory=dict)

    #: A CLIENT-SIDE chain of separate billed requests. Needs the opt-in below.
    fallback_models: Optional[List[str]] = None
    allow_client_fallback: bool = False


@dataclass
class Completion:
    """The OpenAI chat wire, plus the settled receipt for this exact call."""

    choices: List[Dict[str, Any]]
    receipt: Receipt
    fallback_index: int
    id: Optional[str] = None
    model: Optional[str] = None
    usage: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> Optional[str]:
        """First text content of the first choice, or ``None``."""
        if not self.choices:
            return None
        content = (self.choices[0].get("message") or {}).get("content")
        return content if isinstance(content, str) else None


@dataclass
class CatalogModel:
    """One ``GET /v1/models`` entry. ``raw`` keeps every field, losing nothing."""

    id: str
    endpoint_kind: Optional[str] = None
    display_name: Optional[str] = None
    provider: Optional[str] = None
    context_window: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_tools: Optional[int] = None
    #: Declared capabilities. ``None`` means UNDECLARED, not unsupported.
    caps: Optional[List[str]] = None
    #: The AS-CHARGED price for THIS entry's lane only. Never both lanes.
    pricing: Optional[Dict[str, Any]] = None
    #: BYOK take rate as a percent. Display-only.
    fee_pct: Optional[float] = None
    unavailable: Optional[bool] = None
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Balance:
    """Remaining spendable credit."""

    remaining_nano_usd: int
    remaining_usd: str
    included_nano_usd: Optional[int] = None
    allowance_remaining_nano_usd: Optional[int] = None
    credits_remaining_nano_usd: Optional[int] = None


# ------------------------------------------------------------------ embeddings


@dataclass
class EmbeddingsRequest:
    """One embeddings turn.

    The gateway bills embeddings on INPUT ONLY — there is no completion, so
    there is no output term and the catalog carries a zero output rate for
    every embedding seat. That is why this request has no ``max_tokens``, no
    sampling knobs and no stream: none of them mean anything here, and offering
    them would imply a control the wire does not have.
    """

    #: Must DECLARE ``caps: ["embeddings"]``. A chat model is refused with a
    #: 400 naming the chat door.
    model: str
    #: Text, or a batch of texts. A batch returns one vector per member, in the
    #: order you sent them. Token-id arrays are NOT accepted: the gateway
    #: cannot size a spend hold from token ids it did not tokenize.
    input: Any
    #: Matryoshka shortening, on models that support it. Forwarded verbatim.
    dimensions: Optional[int] = None
    #: The WIRE encoding, which is not the same question as what you get back.
    #: Leave it alone unless you need the raw provider bytes: the SDK requests
    #: ``base64`` by default and decodes it for you (same numbers, ~3x less
    #: network). See :meth:`conifer_sdk.client.Embeddings.create`.
    encoding_format: Optional[str] = None
    #: Opaque end-user id, forwarded verbatim for the provider's abuse tooling.
    user: Optional[str] = None

    #: HARD ceiling on the caller-total worst case, in integer nanodollars.
    max_cost_nano_usd: Optional[int] = None
    idempotency_key: Optional[str] = None
    request_id: Optional[str] = None
    #: Your app's name, for your own usage attribution.
    client: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    #: Fields the SDK does not model, merged into the body at your own risk.
    extra_body: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Embedding:
    """One vector, always as floats whatever the wire encoding was."""

    index: int
    embedding: List[float]
    object: Optional[str] = None


@dataclass
class EmbeddingsResponse:
    """One embeddings turn's result, with the settled cost of that call."""

    data: List[Embedding]
    #: The x-conifer-* disclosure, parsed. Embeddings settle in-band, so unlike
    #: a stream the cost IS present here.
    receipt: Receipt
    model: Optional[str] = None
    object: Optional[str] = None
    #: Input tokens only. There is no ``completion_tokens``: there is no
    #: completion.
    usage: Optional[Dict[str, Any]] = None
    #: The provider's own body, untouched — base64 strings included.
    raw: Dict[str, Any] = field(default_factory=dict)


def vector_of(response: EmbeddingsResponse) -> Optional[List[float]]:
    """The first vector, for the overwhelmingly common single-input call."""
    return response.data[0].embedding if response.data else None


# ------------------------------------------------------------ deferred jobs

#: The states a deferred job can never leave. Polling one is a wasted call.
#:
#: The distinction is a money question, not a formality: ``ended``/``fetched``
#: mean you were charged and there is a result, while ``expired``,
#: ``cancelled`` and ``failed`` all carry a refund of the unfinished work.
TERMINAL_JOB_STATUSES = ("fetched", "expired", "cancelled", "failed")


def is_terminal_job(status: Optional[str]) -> bool:
    """True once a job has reached a state it can never leave."""
    return status in TERMINAL_JOB_STATUSES


@dataclass
class DeferredJob:
    """A deferred job, as returned by the 202 accept and by every status poll.

    Carries no content and no cost: the money is disclosed on the RESULT, which
    is a separate call.
    """

    job_id: str
    #: One of queued / submitted / ended / fetched / expired / cancelled / failed.
    status: str
    #: Unix seconds. After this the job expires and unfinished work is refunded.
    deadline_utc: Optional[int] = None
    created_utc: Optional[int] = None
    #: The model the job was accepted for.
    model: Optional[str] = None
    #: The gateway's own poll path, relative to the base URL.
    poll_url: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)
