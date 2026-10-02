"""The ``x-conifer-*`` receipt headers, parsed. A header the gateway omitted
stays ``None``: on a stream the head is sent before the cost settles, so the
routing fields are present and the cost fields are not."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional


@dataclass(frozen=True)
class CostComponents:
    """The four billed token classes, in nanodollars. They sum to the total."""

    fresh: int
    cache_write: int
    cache_read: int
    output: int


@dataclass(frozen=True)
class Receipt:
    """What the turn cost and how it was served."""

    requested_model: Optional[str] = None
    effective_model: Optional[str] = None
    reason: Optional[str] = None
    endpoint: Optional[str] = None
    cost_nano_usd: Optional[int] = None
    cost_usd: Optional[str] = None
    cost_components_nano_usd: Optional[CostComponents] = None
    #: The rate card the itemization was computed under, as ``sha256:<hex>``.
    #: Sent only beside ``cost_components_nano_usd``.
    pricing_identity: Optional[str] = None
    service_tier: Optional[str] = None
    #: The venue that served the turn.
    receipt_venue: Optional[str] = None
    #: Retail counterfactual at the documented default pin. OMITTED unless the
    #: routed predicate holds, and never 0-as-guess: absence means "not
    #: applicable", not "no saving".
    counterfactual_nano_usd: Optional[int] = None
    #: Why a router id served the default pin instead of a routed pick:
    #: ``timeout``, ``unavailable``, ``breaker_open`` or ``saturated``. ``None``
    #: when the router picked or was not involved. The vocabulary grows; treat
    #: unknown values as opaque.
    pin_fallback: Optional[str] = None
    cache: Optional[str] = None
    request_id: Optional[str] = None


def nano_usd_to_usd_string(nano: int) -> str:
    """Nanodollars -> an exact USD decimal string. Integer math only, no float."""
    sign = "-" if nano < 0 else ""
    magnitude = abs(nano)
    return f"{sign}{magnitude // 1_000_000_000}.{magnitude % 1_000_000_000:09d}"


def parse_cost_components(raw: Optional[str]) -> Optional[CostComponents]:
    """``fresh=n,cache_write=n,cache_read=n,output=n`` -> the struct.

    Returns ``None`` unless ALL FOUR parsed: a partial itemization that does not
    sum to the total is worse than none, and the sum identity is the header's
    entire contract.
    """
    if raw is None:
        return None
    seen: dict[str, int] = {}
    for pair in raw.split(","):
        key, _, value = pair.partition("=")
        try:
            seen[key.strip()] = int(value.strip())
        except ValueError:
            continue
    try:
        return CostComponents(
            fresh=seen["fresh"],
            cache_write=seen["cache_write"],
            cache_read=seen["cache_read"],
            output=seen["output"],
        )
    except KeyError:
        return None


def read_receipt(headers: Mapping[str, str]) -> Receipt:
    """Read every receipt header off one response."""
    lowered = {key.lower(): value for key, value in headers.items()}

    def integer(name: str) -> Optional[int]:
        raw = lowered.get(name)
        if raw is None:
            return None
        try:
            return int(raw.strip())
        except ValueError:
            return None

    cost = integer("x-conifer-cost-nanousd")
    return Receipt(
        requested_model=lowered.get("x-conifer-requested-model"),
        effective_model=lowered.get("x-conifer-effective-model"),
        reason=lowered.get("x-conifer-receipt-reason"),
        endpoint=lowered.get("x-conifer-endpoint"),
        cost_nano_usd=cost,
        cost_usd=None if cost is None else nano_usd_to_usd_string(cost),
        cost_components_nano_usd=parse_cost_components(
            lowered.get("x-conifer-cost-components-nanousd")
        ),
        pricing_identity=lowered.get("x-conifer-pricing-identity"),
        service_tier=lowered.get("x-conifer-service-tier"),
        receipt_venue=lowered.get("x-conifer-receipt-venue"),
        counterfactual_nano_usd=integer("x-conifer-counterfactual-nanousd"),
        pin_fallback=lowered.get("x-conifer-receipt-pin-fallback"),
        cache=lowered.get("x-conifer-cache"),
        request_id=lowered.get("x-conifer-request-id") or lowered.get("x-request-id"),
    )


#: The execution receipt headers, in the gateway contract's order.
RECEIPT_HEADERS = (
    "x-conifer-requested-model",
    "x-conifer-effective-model",
    "x-conifer-receipt-reason",
    "x-conifer-endpoint",
    "x-conifer-cost-nanousd",
    "x-conifer-cost-components-nanousd",
    "x-conifer-pricing-identity",
    "x-conifer-service-tier",
    "x-conifer-receipt-venue",
    "x-conifer-counterfactual-nanousd",
    "x-conifer-receipt-pin-fallback",
)


def charged_receipt(headers: Mapping[str, str]) -> Optional[Receipt]:
    """The receipt on an error response, or ``None`` when it carries none. The
    gateway answers an error with the execution receipt only when the error was
    charged, so its presence is the charge."""
    lowered = {key.lower() for key in headers}
    return read_receipt(headers) if any(name in lowered for name in RECEIPT_HEADERS) else None
