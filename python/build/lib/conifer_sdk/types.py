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
