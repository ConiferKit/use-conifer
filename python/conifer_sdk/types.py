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

    #: Models the GATEWAY falls back to, in order, if the requested model's
    #: upstream call fails. Sent as ``x-conifer-fallback-models``.
    #:
    #: Prefer this over ``fallback_models`` for production traffic. The
    #: difference is where the retry lives: ``fallback_models`` is a CLIENT
    #: chain (a second HTTP request, decided here, only after a retryable
    #: refusal reaches you — useless on a stream, separately billed), while
    #: this is ONE request. The gateway holds money once for the whole chain,
    #: dispatches the members in your order, settles ONCE against whichever
    #: served, and refunds in full if none did. Because the gateway sees the
    #: provider's own failure it advances on classes the client never gets to
    #: judge — including the 4xx a mis-configured model surface returns, which
    #: is the failure this exists for.
    #:
    #: Every member is admitted like a primary BEFORE anything is spent: an
    #: unknown model, a composed model, a duplicate, a self-reference, or more
    #: than 3 members is refused by name rather than silently dropped.
    #:
    #: A served fallback is never silent: the receipt's ``effective_model``
    #: names the model that answered and ``reason`` reads ``caller_fallback``.
    #:
    #: Not available with ``defer``, on the BYOK lane, or for composed models.
    server_fallback_models: Optional[List[str]] = None


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

    @property
    def empty_reason(self) -> Optional[str]:
        """Why this completion came back with no text, when it did.

        ``None`` means there is text and nothing to explain. Otherwise this is
        a sentence you can log or raise, because an empty string is the single
        most confusing thing this API returns and the reason is never in the
        content.

        THE TRAP THIS EXISTS FOR (measured live 2026-08-27, on BOTH the OpenAI
        and Anthropic wires). A reasoning model spends ``max_tokens`` on its
        thinking block FIRST. Ask ``claude-fable-5`` a question needing real
        reasoning with ``max_tokens=16`` and you get ``content: ""``,
        ``finish_reason: "length"``, and a bill for 16 output tokens — the
        model never reached the visible answer.

        Nothing about that is a bug, and nothing about it is discoverable: the
        empty string looks like a refusal, a content filter, or a broken SDK,
        and the one distinguishing signal is a field most callers never read.
        So the SDK reads it for you.
        """
        if not self.choices:
            return (
                "the gateway returned no choices at all. If this was a deferred turn, use "
                "defer() and jobs_wait() — a 202 job envelope is not a completion."
            )
        choice = self.choices[0]
        message = choice.get("message") or {}
        content = message.get("content")
        if isinstance(content, str) and content != "":
            return None
        # A tool call IS the answer. Absent text there is correct.
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
                    'Raise max_tokens, or set reasoning={"effort": "none"} / "low" on a model '
                    "that supports it."
                )
            return (
                "the model hit max_tokens before emitting visible text. On a reasoning model "
                "the thinking block is spent FIRST, so a small max_tokens can be consumed "
                "entirely before the answer starts. Raise max_tokens."
            )
        if finish == "content_filter":
            return (
                "the upstream provider's own content filter stopped this turn. Conifer "
                "applies no moderation of its own."
            )
        return f"the model returned empty content with finish_reason {finish!r}."


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
    #: The vector width an embedding seat returns, on rows whose ``caps``
    #: include ``embeddings``.
    #:
    #: Typed rather than left in ``raw`` because it is a DDL decision, not a
    #: curiosity: a pgvector column is declared ``vector(1536)`` before the
    #: first call, and getting it wrong means a migration on a populated
    #: table. The catalog publishes it so you can size the column without
    #: spending a token, and llms.txt tells agents to do exactly that.
    #:
    #: This is the seat's NATIVE width; passing ``dimensions`` on the request
    #: (Matryoshka shortening) overrides it.
    embedding_dimensions: Optional[int] = None
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
