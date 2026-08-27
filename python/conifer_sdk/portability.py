"""Migration shims — the Python twin of src/portability/.

Same law, from cards/portability.card.json: a field Conifer cannot honor
RAISES and names its replacement. Dropping a provider pin, a moderation flag, or
a spend policy is what makes a migration look clean and bill wrong.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .client import DEFAULT_BASE_URL
from .errors import ConiferPortabilityError
from .types import ChatRequest

# ------------------------------------------------------------------ OpenRouter

_OPENROUTER_REFUSALS: Dict[str, str] = {
    "provider": (
        "OpenRouter's `provider` preferences pin a serving host. Conifer picks the host "
        "for the admitted model itself, by price and health, and no client can override "
        "it. Remove the block, or use max_cost_nano_usd if the goal was cost control."
    ),
    "route": (
        '`route: "fallback"` is server-side failover. Conifer admits exactly the model '
        "you name; use `models` with allow_client_fallback=True for an explicit "
        "client-side chain."
    ),
    "plugins": (
        "OpenRouter plugins (web, file-parser, response-healing, context-compression) run "
        "inside their gateway. Conifer has no equivalent, so this request would silently "
        "lose that behavior."
    ),
    "transforms": (
        "`transforms` (middle-out) rewrites your prompt server-side. Conifer refuses an "
        "over-window request with a typed 400 naming the window instead. Trim the prompt "
        "yourself, or pick a model with a larger context window."
    ),
    "prompt": (
        "the legacy text-completion `prompt` field has no Conifer door. Send `messages`."
    ),
}

_UNMODELLED = ("top_k", "min_p", "top_a", "repetition_penalty", "logit_bias", "seed")


def from_openrouter(
    request: Mapping[str, Any],
    allow_client_fallback: bool = False,
    passthrough_unknown: bool = False,
) -> ChatRequest:
    """OpenRouter request -> Conifer request.

    Model ids need no rewriting: the gateway resolves ``vendor/model`` by trying
    the full id first and the last segment second.
    """
    for field, why in _OPENROUTER_REFUSALS.items():
        if request.get(field) is not None:
            raise ConiferPortabilityError(field, why)
    if request.get("model") is None:
        raise ConiferPortabilityError(
            "model",
            "OpenRouter falls back to an account default model when `model` is omitted. "
            "Conifer has no account default: name the model.",
        )
    if request.get("messages") is None:
        raise ConiferPortabilityError("messages", "`messages` is required.")

    extra_body: Dict[str, Any] = {}
    for knob in _UNMODELLED:
        if request.get(knob) is None:
            continue
        if not passthrough_unknown:
            raise ConiferPortabilityError(
                knob,
                f"`{knob}` is not part of Conifer's request card; the upstream may ignore "
                "it. Pass passthrough_unknown=True to forward it anyway, at your own risk.",
            )
        extra_body[knob] = request[knob]

    return ChatRequest(
        model=request["model"],
        messages=list(request["messages"]),
        max_tokens=request.get("max_tokens"),
        temperature=request.get("temperature"),
        top_p=request.get("top_p"),
        stop=request.get("stop"),
        tools=request.get("tools"),
        tool_choice=request.get("tool_choice"),
        response_format=request.get("response_format"),
        reasoning=request.get("reasoning"),
        # `user` is OpenRouter's abuse-detection identifier; the nearest honest
        # Conifer equivalent is caller attribution.
        client=request.get("user"),
        fallback_models=request.get("models"),
        allow_client_fallback=allow_client_fallback,
        extra_body=extra_body,
    )


# -------------------------------------------------------------------- Helicone

_HELICONE_REFUSALS: Dict[str, str] = {
    "helicone-target-url": (
        "Conifer is the destination, not a pass-through proxy. Drop this header and point "
        "your base URL at https://api.conifer.build/v1."
    ),
    "helicone-openai-api-base": (
        "same as Helicone-Target-URL. For Azure, register the resource once as BYOK "
        "custody and keep calling Conifer."
    ),
    "helicone-prompt-id": (
        "Conifer has no server-side prompt registry or versioning. Version prompts in your "
        "own repo."
    ),
    "helicone-moderations-enabled": (
        "Conifer runs no moderation layer. Refusing loudly rather than silently passing an "
        "unmoderated request through."
    ),
    "helicone-llm-security-enabled": (
        "Conifer runs no prompt-injection scanner. Refusing loudly rather than silently "
        "dropping a security control."
    ),
    "helicone-token-limit-exception-handler": (
        "Conifer never truncates or middle-outs your prompt. An over-window request gets a "
        "typed 400 naming the model's window, so you decide what to cut."
    ),
    "helicone-session-id": (
        "Conifer's observability has no session tree. Correlate with your own ids via "
        "x-request-id."
    ),
    "helicone-session-path": "see Helicone-Session-Id.",
    "helicone-session-name": "see Helicone-Session-Id.",
    "helicone-posthog-key": "Conifer does not fan out to third-party analytics.",
    "helicone-posthog-host": "see Helicone-Posthog-Key.",
}


def from_helicone_headers(
    headers: Mapping[str, str]
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """A Helicone header bag -> (Conifer request fields, custom properties).

    The properties come back to YOU because Conifer stores no arbitrary property
    index and will not pretend to.
    """
    lowered = {key.lower(): value for key, value in headers.items() if value is not None}

    for name, why in _HELICONE_REFUSALS.items():
        if name in lowered:
            raise ConiferPortabilityError(name, why)

    properties = {
        key[len("helicone-property-") :]: value
        for key, value in lowered.items()
        if key.startswith("helicone-property-")
    }

    fields: Dict[str, Any] = {}
    if "helicone-request-id" in lowered:
        fields["request_id"] = lowered["helicone-request-id"]
    if "helicone-user-id" in lowered:
        fields["client"] = lowered["helicone-user-id"]

    cache = lowered.get("helicone-cache-enabled")
    if cache == "false":
        fields["prompt_cache"] = "off"
    if cache == "true":
        raise ConiferPortabilityError(
            "helicone-cache-enabled",
            "Conifer decides when to prompt-cache; a client cannot force a cache-WRITE "
            "class it would then be charged for. `false` maps to the real opt-out "
            "(x-conifer-cache: off); `true` has no equivalent.",
        )

    if "helicone-fallbacks" in lowered:
        fields["fallback_models"] = parse_fallbacks(lowered["helicone-fallbacks"])
        # Deliberately NOT auto-enabling allow_client_fallback: the caller has to
        # accept that each member is a separate billed request.

    if "helicone-ratelimit-policy" in lowered:
        fields["max_cost_nano_usd"] = ceiling_from_policy(lowered["helicone-ratelimit-policy"])

    return fields, properties


def parse_fallbacks(raw: str) -> List[str]:
    """``Helicone-Fallbacks`` is a JSON dump; we want the model ids, in order."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as cause:
        raise ConiferPortabilityError(
            "helicone-fallbacks", "Helicone-Fallbacks must be a JSON array; could not parse it."
        ) from cause
    if not isinstance(parsed, list):
        raise ConiferPortabilityError("helicone-fallbacks", "expected a JSON array.")
    models: List[str] = []
    for entry in parsed:
        if isinstance(entry, str):
            models.append(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("model"), str):
            models.append(entry["model"])
        else:
            raise ConiferPortabilityError(
                "helicone-fallbacks",
                "each fallback entry must be a model id string or an object with a `model` "
                "field. Helicone entries that pin a target URL have no Conifer equivalent.",
            )
    return models


def ceiling_from_policy(policy: str) -> int:
    """``[quota];w=[window];u=[unit];s=[segment]`` -> a nanodollar ceiling.

    Only a ``cents`` quota converts: Conifer's control is a per-request MONEY
    ceiling, strictly stronger than a request count but not the same quantity.

    The narrowing is real and worth stating: Helicone's quota is a budget over a
    WINDOW; ``x-conifer-max-cost-nanousd`` caps ONE request. The mapped value is
    an upper bound no single call may exceed, not a running total.
    """
    parts = [part.strip() for part in policy.split(";")]
    try:
        quota = int(parts[0])
    except (ValueError, IndexError) as cause:
        raise ConiferPortabilityError(
            "helicone-ratelimit-policy", "could not read the quota from the policy string."
        ) from cause
    unit = next((part[2:] for part in parts if part.startswith("u=")), None)
    if unit != "cents":
        raise ConiferPortabilityError(
            "helicone-ratelimit-policy",
            f"Conifer's per-request control is a money ceiling, so only `u=cents` maps. "
            f"`u={unit or 'requests'}` has no equivalent: use your own limiter for "
            "request counts.",
        )
    return quota * 10_000_000  # 1 cent = 10^7 nanodollars


# ---------------------------------------------------------------------- Vercel

_VERCEL_UNSUPPORTED: Dict[str, str] = {
    "image-generation": (
        "Conifer serves no image-output door. Keep image generation on your current provider."
    ),
    "oidc": (
        "there is no Conifer OIDC exchange. Mint a key at "
        "https://conifer.build/console#/keys and set CONIFER_API_KEY."
    ),
}


def conifer_openai_compatible_config(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    client: Optional[str] = None,
) -> Dict[str, Any]:
    """The kwargs for an OpenAI-compatible client pointed at Conifer."""
    key = api_key or os.environ.get("CONIFER_API_KEY")
    if not key:
        raise ConiferPortabilityError(
            "api_key",
            "CONIFER_API_KEY is missing. Unlike Vercel's OIDC path there is no ambient "
            "credential to fall back on: supply the key.",
        )
    headers = {"x-conifer-client": client} if client else {}
    return {
        "base_url": f"{(base_url or DEFAULT_BASE_URL).rstrip('/')}/v1",
        "api_key": key,
        "default_headers": headers,
    }


def from_vercel_provider_options(
    provider_options: Mapping[str, Any], allow_client_fallback: bool = False
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """``providerOptions`` -> (Conifer request fields, passthrough options)."""
    gateway = provider_options.get("gateway") or {}
    if gateway.get("order") is not None or gateway.get("only") is not None:
        raise ConiferPortabilityError(
            "providerOptions.gateway.order",
            "provider pinning has no Conifer equivalent: the gateway picks the host for "
            "the admitted model by price and health, and the model you named is always "
            "the model you are charged for. Use max_cost_nano_usd if the goal was cost "
            "control.",
        )
    fields: Dict[str, Any] = {}
    if gateway.get("models") is not None:
        fields["fallback_models"] = list(gateway["models"])
        fields["allow_client_fallback"] = allow_client_fallback
    passthrough = {k: v for k, v in provider_options.items() if k != "gateway"}
    return fields, passthrough


def assert_supported_vercel_surface(surface: str) -> None:
    """Doors Conifer does not serve. Named so a migration fails at the call site."""
    why = _VERCEL_UNSUPPORTED.get(surface)
    if why is not None:
        raise ConiferPortabilityError(surface, why)
