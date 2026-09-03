"""Reading the catalog: models, prices, and the cheapest model that declares
what a caller needs."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .types import CatalogModel


def to_catalog_model(entry: Mapping[str, Any]) -> CatalogModel:
    """A catalog entry from ``GET /v1/models``. ``raw`` keeps every field."""
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
    """One comparable price per model: input plus three times output, in USD
    per million tokens. A ranking key, not a cost forecast. Catalog prices are
    decimal strings; an unrecognised pricing shape is unpriced, not free."""
    if not model.pricing:
        return None
    input_rate = _decimal(model.pricing.get("in_usd_per_mtok"))
    output_rate = _decimal(model.pricing.get("out_usd_per_mtok"))
    if input_rate is None and output_rate is None:
        return None
    return (input_rate or 0.0) + 3 * (output_rate or 0.0)


def _decimal(value: Any) -> Optional[float]:
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
    """The cheapest model that declares every capability in ``caps``. A model
    with no declared caps or no price is skipped, never assumed."""
    eligible = []
    for model in models:
        if model.unavailable:
            continue
        if min_context_window is not None:
            if model.context_window is None or model.context_window < min_context_window:
                continue
        if caps and (model.caps is None or not all(cap in model.caps for cap in caps)):
            continue
        if price_of(model) is None:
            continue
        eligible.append(model)
    if not eligible:
        return None
    return min(eligible, key=lambda m: price_of(m) or 0)
