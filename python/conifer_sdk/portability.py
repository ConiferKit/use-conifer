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
        "`prompt` is the legacy text-completion field. The gateway DOES serve it at "
        "POST /v1/completions (billed and receipted like any other turn), but this shim "
        "converts to the chat wire and this SDK client does not drive that door — and note "
        "/v1/completions is non-streaming, so `stream: true` there is refused. Send "
        "`messages` instead, or call /v1/completions directly with your existing "
        "OpenAI-compatible client."
    ),
}

#: OpenRouter fields Conifer's request card does not model.
#:
#: NOT refusals: the gateway forwards unknown body fields rather than rejecting
#: them (verified live 2026-08-27 — seed, frequency_penalty, presence_penalty,
#: top_logprobs, user, prediction and even an invented field all return 200).
#: Whether the UPSTREAM honors any of them is the provider's business and
#: varies by model, which is why the SDK will not quietly pass them along as
#: though they were guaranteed. They throw by default and forward under
#: ``passthrough_unknown=True``, so the caller opts in with eyes open.
#:
#: KEEPING THIS LIST HONEST IS THE JOB. A field neither refused nor listed here
#: is SILENTLY DROPPED, violating the first law on the portability card. Five
#: were being dropped exactly that way until this was checked against
#: OpenRouter's current published schema rather than against our own card.
_UNMODELLED = (
    "top_k",
    "min_p",
    "top_a",
    "repetition_penalty",
    "logit_bias",
    "seed",
    # Added 2026-08-27 from OpenRouter's current schema. Each was previously
    # accepted and then dropped without a word.
    "frequency_penalty",
    "presence_penalty",
    "top_logprobs",
    "prediction",
    "debug",
)


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



def attribution_from_openrouter(headers: Mapping[str, str]) -> Optional[str]:
    """OpenRouter's app-attribution headers -> the Conifer caller tag.

    ``HTTP-Referer`` and ``X-Title`` exist to rank your app on OpenRouter's
    public board. Conifer has no such board, so they become usage attribution
    only. Twin of ``attributionFromOpenRouter`` in the TypeScript SDK, which
    Python was missing entirely.
    """
    lower = {key.lower(): value for key, value in headers.items()}
    # `X-OpenRouter-Categories` assigns MARKETPLACE categories on openrouter.ai.
    # Conifer runs no marketplace and no public leaderboard, so there is nothing
    # for it to become. Refusing beats returning it as an app name — which is
    # what a lenient reading would do, mislabelling every turn's attribution.
    if "x-openrouter-categories" in lower:
        raise ConiferPortabilityError(
            "X-OpenRouter-Categories",
            "this header assigns categories in OpenRouter's public model marketplace. "
            "Conifer has no marketplace or leaderboard to list your app on, so there is no "
            "equivalent. Drop it; x-conifer-client carries the app NAME for your own usage "
            "attribution.",
        )
    return lower.get("x-openrouter-title") or lower.get("x-title") or lower.get("http-referer")


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
    # PRIVACY. Dropping either is the worst case in this file: the request
    # succeeds, nothing errors, and a promise the caller made to THEIR OWN
    # users — that prompts or completions are not retained — has quietly lapsed.
    "helicone-omit-request": (
        "Conifer has no per-request switch to omit the prompt from what it retains, so "
        "this cannot be honored and MUST NOT be dropped — it is a promise you may have "
        "made to your own users. See https://conifer.build/privacy for what the gateway "
        "retains, and decide with that in hand."
    ),
    "helicone-omit-response": (
        "Conifer has no per-request switch to omit the completion from what it retains, "
        "so this cannot be honored and MUST NOT be dropped — it is a promise you may have "
        "made to your own users. See https://conifer.build/privacy for what the gateway "
        "retains, and decide with that in hand."
    ),
    "helicone-auth": (
        "this is your HELICONE credential, and it means the request was going through "
        "Helicone as a proxy. Conifer is the destination: drop it and authenticate with "
        "CONIFER_API_KEY."
    ),
    "helicone-retry-enabled": (
        "Helicone retries server-side on its own policy. This SDK retries in the CLIENT, "
        "narrowly (transport faults and 409/429/502/503/504), and every retry reuses one "
        "idempotency key so it cannot double-bill. Set max_retries for a different budget "
        "— but a server-side retry you cannot see is not something Conifer will imitate."
    ),
}

#: Helicone headers that are OBSERVED rather than converted: they change what
#: Helicone recorded, not what the model did, so there is nothing to refuse and
#: nothing to send. Listed so the catch-all can tell "deliberately inert" from
#: "we have never heard of this".
_HELICONE_INERT = {
    "helicone-cache-enabled",
    "helicone-request-id",
    "helicone-user-id",
    "helicone-fallbacks",
    "helicone-ratelimit-policy",
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

    # Anything left is a Helicone header we have never heard of. NOT safe to
    # ignore: an unknown header is exactly the case where we cannot judge
    # whether it carried a constraint, and this shim exists so that a
    # constraint cannot go missing in transit. (Two of the headers above are
    # privacy promises that were being dropped here until 2026-08-27.)
    unknown = [
        key
        for key in lowered
        if key.startswith("helicone-")
        and not key.startswith("helicone-property-")
        and key not in _HELICONE_INERT
        and key not in _HELICONE_REFUSALS
    ]
    if unknown:
        joined = "`, `".join(unknown)
        raise ConiferPortabilityError(
            unknown[0],
            f"`{joined}` "
            f"{'is a Helicone header' if len(unknown) == 1 else 'are Helicone headers'} "
            "this shim does not recognize. It is refused rather than ignored, because an "
            "observability or privacy control that vanishes in migration is the one "
            "failure this shim exists to prevent. Remove it, or open an issue if Conifer "
            "should honor it.",
        )

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
    # Verified live 2026-08-27: each of these answers 404 with `unknown_url`.
    "rerank": (
        "Conifer does not serve reranking. The embedding models on this gateway "
        '(GET /v1/models, caps includes "embeddings") can rank by cosine similarity, '
        "or keep reranking on your current provider."
    ),
    "moderations": (
        "Conifer serves no moderation door, and never silently applies one either — "
        "what you send is what runs. Keep moderation on your current provider."
    ),
    "audio": (
        "Conifer serves no audio door (neither speech nor transcription). Keep audio "
        "on your current provider."
    ),
    "files": (
        "Conifer serves no Files API. There is no server-side document store to upload "
        "to; send content in the request itself."
    ),
    "batches": (
        "Conifer serves no Batches API. The nearest equivalent is a deferred job: "
        "defer() submits the turn against a >=24h window and jobs_wait() collects it."
    ),
}

#: Aliases, so a caller who spells the surface the way THEIR old SDK spelled it
#: gets the explanation rather than silence.
_VERCEL_SURFACE_ALIASES: Dict[str, str] = {
    "image": "image-generation",
    "images": "image-generation",
    "moderation": "moderations",
    "reranking": "rerank",
    "speech": "audio",
    "transcription": "audio",
    "audio-speech": "audio",
    "audio-transcription": "audio",
    "batch": "batches",
    "file": "files",
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


#: Every ``providerOptions.gateway`` key Vercel documents, and why it refuses.
#:
#: THE FAILURE THIS PREVENTS. An earlier version refused only ``order`` and
#: ``only``, converted ``models``, and let EVERYTHING ELSE fall out of the dict
#: unremarked — so a caller who had set ``zdr`` or ``dataCollection`` migrated to
#: Conifer and silently lost the constraint. That is the exact failure the
#: portability card's first law forbids, and for the privacy keys it is the most
#: consequential possible instance: the request still runs, nothing errors, and
#: a promise the caller made to THEIR users is quietly no longer being kept.
#:
#: The rule: a gateway key is converted, or it throws. Never dropped.
_VERCEL_GATEWAY_REFUSALS: Dict[str, str] = {
    "order": (
        "provider pinning has no Conifer equivalent: the gateway picks the host for the "
        "admitted model by price and health, and the model you named is always the model "
        "you are charged for. Use max_cost_nano_usd if the goal was cost control."
    ),
    "only": (
        "restricting which providers may serve a model has no Conifer equivalent — the "
        "gateway admits the model, then chooses the host itself. Use max_cost_nano_usd if "
        "the goal was cost control."
    ),
    "ignore": (
        "excluding specific providers has no Conifer equivalent: host selection is the "
        "gateway's, and it is not overridable per request."
    ),
    "sort": (
        "Conifer does not expose a provider sort order. The gateway already selects by "
        "price and health for the model you named; there is no second ranking to override."
    ),
    "allowFallbacks": (
        "server-side provider fallback has no Conifer equivalent — the gateway admits "
        "exactly the model you name. Use fallback_models with allow_client_fallback=True "
        "for an explicit CLIENT-side chain of separately billed turns."
    ),
    "requireParameters": (
        "Conifer does not filter hosts by which sampling parameters they implement. Send "
        "the parameters you need; an upstream that ignores one is the upstream's behavior."
    ),
    "require_parameters": (
        "Conifer does not filter hosts by which sampling parameters they implement. Send "
        "the parameters you need; an upstream that ignores one is the upstream's behavior."
    ),
    "quantizations": (
        "Conifer does not let a caller select a host by weight quantization. The catalog "
        "entry you name is the one served."
    ),
    "maxPrice": (
        "a per-token price ceiling has no direct equivalent, and silently approximating "
        "one would be worse than refusing. Use max_cost_nano_usd, a HARD ceiling on the "
        "whole turn's worst case, enforced before any upstream call."
    ),
    # PRIVACY constraints. Dropping either is the worst case in this file: the
    # turn still succeeds, so nothing surfaces, while a commitment the caller
    # made to their own users has quietly lapsed.
    "dataCollection": (
        "Conifer has no per-request data-collection toggle, so this cannot be honored and "
        "MUST NOT be dropped — it is a promise you may have made to your own users. See "
        "https://conifer.build/privacy for what the gateway retains."
    ),
    "zdr": (
        "zero-data-retention is not a per-request flag on Conifer, so this cannot be "
        "honored and MUST NOT be dropped — it is a promise you may have made to your own "
        "users. See https://conifer.build/privacy for what the gateway retains."
    ),
}


def from_vercel_provider_options(
    provider_options: Mapping[str, Any], allow_client_fallback: bool = False
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """``providerOptions`` -> (Conifer request fields, passthrough options).

    Keys under ``gateway`` are Vercel-specific routing controls, and every one
    is either converted or refused. Keys for OTHER providers are returned for
    you to place in ``extra_body`` deliberately.
    """
    gateway = provider_options.get("gateway") or {}
    for key, why in _VERCEL_GATEWAY_REFUSALS.items():
        if gateway.get(key) is not None:
            raise ConiferPortabilityError(f"providerOptions.gateway.{key}", why)
    fields: Dict[str, Any] = {}
    if gateway.get("models") is not None:
        fields["fallback_models"] = list(gateway["models"])
        fields["allow_client_fallback"] = allow_client_fallback
    # Anything left is a control we have never heard of. NOT safe to ignore:
    # an unknown key is exactly the case where we cannot judge whether it
    # mattered, and the whole point is that a constraint cannot go missing.
    unknown = [k for k, v in gateway.items() if k != "models" and v is not None]
    if unknown:
        joined = "`, `".join(unknown)
        raise ConiferPortabilityError(
            f"providerOptions.gateway.{unknown[0]}",
            f"`{joined}` "
            f"{'is a Vercel gateway control' if len(unknown) == 1 else 'are Vercel gateway controls'} "
            "this shim does not recognize. It is refused rather than ignored, because a "
            "routing or privacy constraint that vanishes in migration is the one failure "
            "this shim exists to prevent. Remove it, or open an issue if Conifer should "
            "honor it.",
        )
    passthrough = {k: v for k, v in provider_options.items() if k != "gateway"}
    return fields, passthrough


def assert_supported_vercel_surface(surface: str) -> None:
    """Refuse, at the CALL SITE, a surface this gateway does not serve.

    The alternative is a 404 at runtime, in production, with a provider name in
    it and no indication of what to do — which is exactly how a migration
    "succeeds" and then fails on the one code path nobody exercised. Every
    entry was probed against api.conifer.build on 2026-08-27.

    Note what is NOT here: ``embeddings``. It was listed until the gateway
    shipped ``/v1/embeddings`` on 2026-08-26, and the SDK now serves that door
    directly (:meth:`conifer_sdk.Conifer.embed`). A shim that refuses a surface
    the gateway actually serves is as wrong as one that admits a surface it
    does not.
    """
    key = _VERCEL_SURFACE_ALIASES.get(surface, surface)
    why = _VERCEL_UNSUPPORTED.get(key)
    if why is not None:
        raise ConiferPortabilityError(surface, why)
