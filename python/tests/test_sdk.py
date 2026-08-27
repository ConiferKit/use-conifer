"""The Python SDK, tested through its public seam with an injected transport.

Parity matters as much as correctness here: a team with a Python service and a
TypeScript app must get the SAME refusals and the SAME receipt from both, or the
"one SDK, two languages" claim is marketing. The parity assertions at the bottom
check that against the shared cards.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from conifer_sdk import (  # noqa: E402
    Conifer,
    ConiferAuthError,
    ConiferBadRequestError,
    ConiferCostCeilingError,
    ConiferConflictError,
    ConiferError,
    ConiferKeySpendCapError,
    ConiferModelNotFoundError,
    ConiferPaymentError,
    ConiferPortabilityError,
    ConiferRateLimitError,
    ConiferTimeoutError,
    ReceiptCollector,
    SpendBudget,
    SpendBudgetExceeded,
    EmbeddingsRequest,
    MIN_DEFER_WINDOW_SECONDS,
    TERMINAL_JOB_STATUSES,
    is_terminal_job,
    to_deferred_job,
    with_cost,
    vector_of,
    ceiling_from_policy,
    conifer_openai_compatible_config,
    from_helicone_headers,
    from_openrouter,
    attribution_from_openrouter,
    from_vercel_provider_options,
    nano_usd_to_usd_string,
    parse_fallbacks,
    read_receipt,
    resolve_base_url,
)
from conifer_sdk.client import (  # noqa: E402
    minimum_backoff_seconds,
    decode_vector,
    embeddings_body,
    embeddings_headers,
    chat_body,
    parse_frame,
    chat_headers,
    pick_cheapest,
    resolve_chain,
)
from conifer_sdk.errors import error_from  # noqa: E402
from conifer_sdk.portability import assert_supported_vercel_surface  # noqa: E402
from conifer_sdk.receipt import Receipt, parse_cost_components  # noqa: E402
from conifer_sdk.types import CatalogModel, ChatRequest, Completion  # noqa: E402

CARDS = Path(__file__).resolve().parents[2] / "cards"

RECEIPT_HEADERS = {
    "x-conifer-requested-model": "anthropic/claude-haiku-4-5",
    "x-conifer-effective-model": "claude-haiku-4-5",
    "x-conifer-endpoint": "conifer",
    "x-conifer-cost-nanousd": "1250000",
    "x-conifer-cost-components-nanousd": "fresh=1000000,cache_write=0,cache_read=50000,output=200000",
    "x-conifer-request-id": "req-abc",
}

COMPLETION = {
    "id": "chatcmpl-1",
    "model": "claude-haiku-4-5",
    "choices": [{"message": {"role": "assistant", "content": "pinecone"}}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 3},
}


def scripted(*responses):
    """A transport that records calls and replays a scripted queue."""
    calls = []
    queue = list(responses)

    def transport(method, url, headers, body, timeout):
        calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": json.loads(body) if body else None,
            }
        )
        if not queue:
            raise AssertionError("no scripted response left")
        status, response_headers, payload = queue.pop(0)
        return status, response_headers, json.dumps(payload)

    return calls, transport


def client(transport, **kwargs):
    return Conifer(api_key="sk-conifer-test", transport=transport, max_retries=0, **kwargs)


class ChatTests(unittest.TestCase):
    def test_turn_sends_the_openai_wire_and_parses_the_receipt(self):
        calls, transport = scripted((200, RECEIPT_HEADERS, COMPLETION))
        completion = client(transport).chat(
            ChatRequest(
                model="anthropic/claude-haiku-4-5",
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=64,
            )
        )
        call = calls[0]
        self.assertEqual(call["url"], "https://api.conifer.build/v1/chat/completions")
        self.assertEqual(call["headers"]["authorization"], "Bearer sk-conifer-test")
        self.assertEqual(call["body"]["max_tokens"], 64)
        self.assertEqual(completion.text, "pinecone")
        self.assertEqual(completion.receipt.cost_nano_usd, 1_250_000)
        self.assertEqual(completion.receipt.cost_usd, "0.001250000")
        self.assertEqual(completion.fallback_index, 0)

    def test_every_post_carries_an_idempotency_key(self):
        calls, transport = scripted((200, {}, COMPLETION))
        client(transport).chat(ChatRequest(model="m", messages=[]))
        self.assertTrue(calls[0]["headers"]["idempotency-key"].startswith("idem-"))

    def test_a_retry_reuses_the_same_idempotency_key(self):
        calls, transport = scripted(
            (503, {}, {"error": {"type": "service_unavailable", "message": "down"}}),
            (200, {}, COMPLETION),
        )
        Conifer(api_key="k", transport=transport, max_retries=1).chat(
            ChatRequest(model="m", messages=[])
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(
            calls[0]["headers"]["idempotency-key"], calls[1]["headers"]["idempotency-key"]
        )

    def test_a_gateway_authored_4xx_is_never_retried(self):
        calls, transport = scripted((400, {}, {"error": {"type": "invalid_request", "message": "bad"}}))
        with self.assertRaises(ConiferPortabilityError.__mro__[1]):
            Conifer(api_key="k", transport=transport, max_retries=3).chat(
                ChatRequest(model="m", messages=[])
            )
        self.assertEqual(len(calls), 1)

    def test_two_kinds_of_402_are_two_classes(self):
        _, ceiling = scripted(
            (
                402,
                {},
                {
                    "error": {
                        "type": "cost_ceiling_exceeded",
                        "message": "projected worst-case cost 5000000 nanodollars exceeds the ceiling 1000000",
                    }
                },
            )
        )
        with self.assertRaises(ConiferCostCeilingError) as caught:
            client(ceiling).chat(ChatRequest(model="m", messages=[], max_cost_nano_usd=1_000_000))
        self.assertEqual(caught.exception.projected_nano_usd, 5_000_000)
        self.assertEqual(caught.exception.ceiling_nano_usd, 1_000_000)
        self.assertFalse(caught.exception.retryable)

        _, balance = scripted(
            (
                402,
                {},
                {
                    "error": {
                        "type": "insufficient_allowance",
                        "message": "insufficient allowance: needs up to 900 nanodollars but you hold 100",
                    }
                },
            )
        )
        with self.assertRaises(ConiferPaymentError) as caught:
            client(balance).chat(ChatRequest(model="m", messages=[]))
        self.assertEqual(caught.exception.required_nano_usd, 900)
        self.assertEqual(caught.exception.balance_nano_usd, 100)

    def test_rate_limit_carries_retry_after(self):
        _, transport = scripted(
            (429, {"retry-after": "7"}, {"error": {"type": "rate_limited", "message": "slow"}})
        )
        with self.assertRaises(ConiferRateLimitError) as caught:
            client(transport).chat(ChatRequest(model="m", messages=[]))
        self.assertEqual(caught.exception.retry_after_seconds, 7)
        self.assertTrue(caught.exception.retryable)

    def test_a_retryable_failure_advances_the_chain(self):
        calls, transport = scripted(
            (503, {}, {"error": {"type": "service_unavailable", "message": "down"}}),
            (200, RECEIPT_HEADERS, COMPLETION),
        )
        completion = client(transport).chat(
            ChatRequest(
                model="primary",
                messages=[],
                fallback_models=["backup"],
                allow_client_fallback=True,
            )
        )
        self.assertEqual(completion.fallback_index, 1)
        self.assertEqual(calls[0]["body"]["model"], "primary")
        self.assertEqual(calls[1]["body"]["model"], "backup")
        self.assertNotEqual(
            calls[0]["headers"]["idempotency-key"],
            calls[1]["headers"]["idempotency-key"],
            "a different body needs a different key",
        )

    def test_a_non_retryable_refusal_does_not_advance_the_chain(self):
        calls, transport = scripted((404, {}, {"error": {"type": "model_not_found", "message": "no"}}))
        with self.assertRaises(ConiferModelNotFoundError):
            client(transport).chat(
                ChatRequest(
                    model="missing",
                    messages=[],
                    fallback_models=["other"],
                    allow_client_fallback=True,
                )
            )
        self.assertEqual(len(calls), 1)

    def test_a_chain_needs_the_explicit_opt_in(self):
        with self.assertRaises(ConiferPortabilityError):
            resolve_chain(ChatRequest(model="a", messages=[], fallback_models=["b"]))
        self.assertEqual(
            resolve_chain(
                ChatRequest(
                    model="a", messages=[], fallback_models=["b"], allow_client_fallback=True
                )
            ),
            ["a", "b"],
        )


class WireTests(unittest.TestCase):
    def test_hard_constraints_ride_as_headers_advisory_ones_as_both(self):
        request = ChatRequest(
            model="m",
            messages=[],
            max_cost_nano_usd=5_000_000,
            deadline_seconds=600,
            defer=True,
            venue="cloud",
            prompt_cache="off",
            client="slack-bot",
        )
        headers = chat_headers(request, "idem-1")
        self.assertEqual(headers["x-conifer-max-cost-nanousd"], "5000000")
        self.assertEqual(headers["x-conifer-deadline"], "600")
        self.assertEqual(headers["x-conifer-defer"], "allow")
        self.assertEqual(headers["x-conifer-venue"], "cloud")
        self.assertEqual(headers["x-conifer-cache"], "off")
        self.assertEqual(headers["x-conifer-client"], "slack-bot")

        body = chat_body(request)
        self.assertEqual(body["completion_window_seconds"], 600)
        self.assertEqual(body["defer"], "allow")

    def test_a_fractional_ceiling_is_refused_not_rounded(self):
        with self.assertRaises(ConiferPortabilityError):
            chat_headers(ChatRequest(model="m", messages=[], max_cost_nano_usd=1.5), "idem")

    def test_a_stream_always_asks_for_the_usage_chunk(self):
        body = chat_body(ChatRequest(model="m", messages=[]), stream=True)
        self.assertTrue(body["stream"])
        self.assertEqual(body["stream_options"], {"include_usage": True})

    def test_receipt_preserves_absence(self):
        receipt = read_receipt({"x-conifer-cost-nanousd": "42"})
        self.assertEqual(receipt.cost_nano_usd, 42)
        self.assertIsNone(receipt.cost_components_nano_usd)
        self.assertIsNone(receipt.service_tier)

    def test_the_two_newer_receipt_headers_are_parsed(self):
        receipt = read_receipt(
            {
                "x-conifer-receipt-venue": "cloud",
                "x-conifer-counterfactual-nanousd": "9000000",
            }
        )
        self.assertEqual(receipt.receipt_venue, "cloud")
        self.assertEqual(receipt.counterfactual_nano_usd, 9_000_000)

    def test_a_partial_itemization_is_discarded(self):
        self.assertIsNone(parse_cost_components("fresh=1,output=2"))
        full = parse_cost_components("fresh=1,cache_write=2,cache_read=3,output=4")
        self.assertEqual((full.fresh, full.cache_write, full.cache_read, full.output), (1, 2, 3, 4))

    def test_nanodollars_render_exactly(self):
        self.assertEqual(nano_usd_to_usd_string(1), "0.000000001")
        self.assertEqual(nano_usd_to_usd_string(1_000_000_000), "1.000000000")
        self.assertEqual(nano_usd_to_usd_string(123_456_789_012), "123.456789012")

    def test_a_stray_openai_base_url_cannot_redirect_conifer_traffic(self):
        self.assertEqual(
            resolve_base_url(None, {"OPENAI_BASE_URL": "https://api.openai.com/v1"}),
            "https://api.conifer.build",
        )
        self.assertEqual(
            resolve_base_url(None, {"OPENAI_BASE_URL": "https://api.conifer.build/v1"}),
            "https://api.conifer.build",
        )
        self.assertEqual(
            resolve_base_url(None, {"CONIFER_BASE_URL": "https://staging.conifer.build/v1/"}),
            "https://staging.conifer.build",
        )

    def test_catalog_and_balance_read_without_loss(self):
        _, transport = scripted(
            (
                200,
                {},
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "a",
                            "caps": ["tools"],
                            "pricing": {"in_usd_per_mtok": "1", "out_usd_per_mtok": "5"},
                            "context_window": 100,
                        },
                        {"id": "bare", "endpoint_kind": "byok", "fee_pct": 4.5},
                    ],
                },
            )
        )
        models = client(transport).models()
        self.assertEqual(models[0].context_window, 100)
        self.assertIsNone(models[1].caps, "undeclared caps stay None, never []")
        self.assertEqual(models[1].fee_pct, 4.5)
        self.assertEqual(models[0].raw["id"], "a")

        _, transport = scripted((200, {}, {"remaining_nanodollars": 12_500_000_000}))
        balance = client(transport).balance()
        self.assertEqual(balance.remaining_usd, "12.500000000")

    def test_cheapest_reads_the_catalogs_decimal_string_prices(self):
        # Regression: an earlier version summed only NUMERIC pricing values, so
        # against the real catalog (money as strings) every model ranked as
        # unpriced and cheapest_for returned nothing at all.
        def priced(inp, out):
            return {"in_usd_per_mtok": inp, "out_usd_per_mtok": out}

        models = [
            CatalogModel(id="no-caps", pricing=priced("1", "1")),
            CatalogModel(id="cheap", caps=["tools"], pricing=priced("1", "5")),
            CatalogModel(id="dear", caps=["tools"], pricing=priced("10", "50")),
            CatalogModel(id="unpriced", caps=["tools"]),
            CatalogModel(id="degraded", caps=["tools"], pricing=priced("0.1", "0.1"), unavailable=True),
        ]
        self.assertEqual(pick_cheapest(models, ["tools"]).id, "cheap")
        self.assertIsNone(pick_cheapest(models, ["tools"], min_context_window=1))

    def test_output_rate_is_weighted_and_unknown_shapes_are_unpriced(self):
        from conifer_sdk.client import price_of

        trap = CatalogModel(id="trap", pricing={"in_usd_per_mtok": "0.5", "out_usd_per_mtok": "100"})
        balanced = CatalogModel(id="balanced", pricing={"in_usd_per_mtok": "2", "out_usd_per_mtok": "6"})
        self.assertEqual(pick_cheapest([trap, balanced]).id, "balanced")
        self.assertIsNone(price_of(CatalogModel(id="x", pricing={"future_field": "3"})))
        self.assertEqual(
            price_of(CatalogModel(id="x", pricing={"in_usd_per_mtok": "10", "out_usd_per_mtok": "50"})),
            160,
        )

    def test_a_missing_key_fails_at_construction(self):
        with self.assertRaises(Exception) as caught:
            Conifer(api_key=None, env={})
        self.assertIn("CONIFER_API_KEY", str(caught.exception))


class StreamTests(unittest.TestCase):
    """Parity with the TypeScript stream(): same opt-in refusal, same frames."""

    def test_a_fallback_chain_cannot_ride_a_stream(self):
        c = client(lambda *a: None)
        with self.assertRaises(ConiferPortabilityError):
            list(
                c.stream(
                    ChatRequest(
                        model="m",
                        messages=[],
                        fallback_models=["b"],
                        allow_client_fallback=True,
                    )
                )
            )

    def test_frames_parse_and_terminators_yield_nothing(self):
        self.assertIsNone(parse_frame("data: [DONE]"))
        self.assertIsNone(parse_frame(": keep-alive"))
        self.assertIsNone(parse_frame(""))
        self.assertEqual(parse_frame('data: {"id":"x"}'), {"id": "x"})

    def test_a_stream_body_always_requests_the_terminal_usage_chunk(self):
        body = chat_body(ChatRequest(model="m", messages=[]), stream=True)
        self.assertEqual(body["stream_options"], {"include_usage": True})


class PortabilityTests(unittest.TestCase):
    def refuses(self, field, run):
        with self.assertRaises(ConiferPortabilityError) as caught:
            run()
        self.assertEqual(caught.exception.field, field)
        self.assertGreater(len(caught.exception.message), 40, "a refusal must say what to do")

    def test_openrouter_converts_field_for_field(self):
        converted = from_openrouter(
            {
                "model": "anthropic/claude-opus-5",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 100,
                "temperature": 0.7,
                "user": "user-42",
            }
        )
        self.assertEqual(converted.model, "anthropic/claude-opus-5")
        self.assertEqual(converted.max_tokens, 100)
        self.assertEqual(converted.client, "user-42")

    def test_openrouter_server_side_controls_refuse(self):
        base = {"model": "m", "messages": []}
        self.refuses("provider", lambda: from_openrouter({**base, "provider": {"order": ["x"]}}))
        self.refuses("route", lambda: from_openrouter({**base, "route": "fallback"}))
        self.refuses("plugins", lambda: from_openrouter({**base, "plugins": [{"id": "web"}]}))
        self.refuses("transforms", lambda: from_openrouter({**base, "transforms": ["middle-out"]}))
        self.refuses("prompt", lambda: from_openrouter({**base, "prompt": "legacy"}))
        self.refuses("model", lambda: from_openrouter({"messages": []}))

    def test_unmodelled_knobs_refuse_unless_passed_through(self):
        self.refuses("top_k", lambda: from_openrouter({"model": "m", "messages": [], "top_k": 40}))
        forwarded = from_openrouter(
            {"model": "m", "messages": [], "top_k": 40}, passthrough_unknown=True
        )
        self.assertEqual(forwarded.extra_body, {"top_k": 40})

    def test_helicone_headers_map_to_real_inputs(self):
        fields, properties = from_helicone_headers(
            {
                "Helicone-Request-Id": "req-1",
                "Helicone-User-Id": "alice",
                "Helicone-Property-App": "mobile",
                "Helicone-Cache-Enabled": "false",
            }
        )
        self.assertEqual(fields["request_id"], "req-1")
        self.assertEqual(fields["client"], "alice")
        self.assertEqual(fields["prompt_cache"], "off")
        self.assertEqual(properties, {"app": "mobile"})

    def test_helicone_safety_and_proxy_headers_refuse(self):
        for header in [
            "helicone-target-url",
            "helicone-moderations-enabled",
            "helicone-llm-security-enabled",
            "helicone-token-limit-exception-handler",
            "helicone-prompt-id",
            "helicone-session-id",
        ]:
            self.refuses(header, lambda h=header: from_helicone_headers({h: "x"}))
        self.refuses(
            "helicone-cache-enabled",
            lambda: from_helicone_headers({"Helicone-Cache-Enabled": "true"}),
        )

    def test_rate_limit_policy_maps_only_in_cents(self):
        self.assertEqual(ceiling_from_policy("10;w=1000;u=cents;s=user"), 100_000_000)
        self.refuses(
            "helicone-ratelimit-policy", lambda: ceiling_from_policy("10;w=60;u=requests")
        )

    def test_fallbacks_parse_from_either_shape(self):
        self.assertEqual(parse_fallbacks('["a","b"]'), ["a", "b"])
        self.assertEqual(parse_fallbacks('[{"model":"a"}]'), ["a"])
        self.refuses("helicone-fallbacks", lambda: parse_fallbacks("not json"))
        self.refuses("helicone-fallbacks", lambda: parse_fallbacks('[{"target_url":"x"}]'))

    def test_vercel_config_and_refusals(self):
        config = conifer_openai_compatible_config(api_key="sk-x", client="app")
        self.assertEqual(config["base_url"], "https://api.conifer.build/v1")
        self.assertEqual(config["default_headers"]["x-conifer-client"], "app")

        self.refuses(
            "providerOptions.gateway.order",
            lambda: from_vercel_provider_options({"gateway": {"order": ["anthropic"]}}),
        )
        fields, passthrough = from_vercel_provider_options(
            {"gateway": {"models": ["b"]}, "anthropic": {"thinking": True}},
            allow_client_fallback=True,
        )
        self.assertEqual(fields["fallback_models"], ["b"])
        self.assertEqual(passthrough, {"anthropic": {"thinking": True}})

        # /v1/embeddings SHIPPED on 2026-08-26 — the shim must not refuse it.
        assert_supported_vercel_surface("embeddings")
        self.refuses("oidc", lambda: assert_supported_vercel_surface("oidc"))

        # Probed live 2026-08-27: each of these answers 404 `unknown_url`. A
        # 404 in production, on the one path nobody exercised, is exactly how
        # a migration "succeeds" and then fails.
        for surface in ("rerank", "moderations", "audio", "files", "batches"):
            self.refuses(surface, lambda s=surface: assert_supported_vercel_surface(s))

        # Spelled the way ANOTHER SDK spells it, the caller still gets the
        # reason rather than silence.
        for alias in (
            "image",
            "images",
            "moderation",
            "reranking",
            "speech",
            "transcription",
            "audio-speech",
            "audio-transcription",
            "batch",
            "file",
        ):
            self.refuses(alias, lambda a=alias: assert_supported_vercel_surface(a))

    def test_the_card_and_the_shim_agree_on_which_doors_are_served(self):
        """The card is the contract, so the refusal list is driven FROM it.

        An entry added to the card without a matching refusal in code (or the
        reverse) fails here, which is the only thing that keeps a migration
        document honest as the gateway's served surface changes. Twin of the
        same assertion in tests/portability.test.ts.
        """
        vercel = json.loads(
            (Path(__file__).resolve().parents[2] / "cards/portability.card.json").read_text()
        )["vercel_ai_gateway"]
        for label in vercel["unsupported_refused"]:
            # The card's keys are prose ("audio (speech and transcription)");
            # the first word is the surface token the shim is called with.
            surface = label.split(" ")[0].lower()
            if surface == "oidc":
                continue  # spelled the same, covered above
            with self.assertRaises(ConiferPortabilityError, msg=f"card refuses {label}"):
                assert_supported_vercel_surface(surface)
        # And the inverse: a door the card records as NOW SERVED must not throw.
        for label in vercel["now_served"]:
            if label == "note":
                continue
            surface = label.split("/")[-1]
            assert_supported_vercel_surface(surface)


class ParityTests(unittest.TestCase):
    """Both languages must refuse the same things, or "one SDK" is a slogan."""

    def setUp(self):
        self.portability = json.loads((CARDS / "portability.card.json").read_text())

    def test_every_documented_openrouter_refusal_is_enforced_here_too(self):
        for field in self.portability["openrouter"]["unsupported_refused"]:
            if "/" in field:
                continue
            with self.assertRaises(ConiferPortabilityError, msg=f"openrouter.{field}"):
                from_openrouter({"model": "m", "messages": [], field: "x"})

    def test_every_documented_openrouter_header_refusal_is_enforced(self):
        # Headers are refused by attribution_from_openrouter, not by the body
        # converter, so they live in their own card section and are driven
        # through their own entry point.
        for name in self.portability["openrouter"]["unsupported_refused_headers"]:
            if name == "note":
                continue
            with self.assertRaises(ConiferPortabilityError, msg=f"openrouter header {name}"):
                attribution_from_openrouter({name: "x"})

    def test_every_documented_helicone_refusal_is_enforced_here_too(self):
        for field in self.portability["helicone"]["unsupported_refused"]:
            if field.endswith("*"):
                continue
            name = field.split(" / ")[0]
            with self.assertRaises(ConiferPortabilityError, msg=f"helicone.{name}"):
                from_helicone_headers({name: "x"})

    def test_the_timeout_matches_the_gateways_edge_cut(self):
        from conifer_sdk import DEFAULT_TIMEOUT_SECONDS

        # The vendored gateway contract (see contracts/gateway-contract.json and
        # the note in tests/cards.test.ts): pinned in-repo so this suite runs
        # offline in any clone, and so both languages check the same bytes.
        contract = json.loads(
            (
                Path(__file__).resolve().parents[2]
                / "contracts/gateway-contract.json"
            ).read_text()
        )
        self.assertEqual(DEFAULT_TIMEOUT_SECONDS, contract["timeouts_secs"]["edge_silent_cut"])


def _contract() -> dict:
    """The vendored gateway wire contract. Same bytes both languages read."""
    return json.loads(
        (Path(__file__).resolve().parents[2] / "contracts/gateway-contract.json").read_text()
    )


class ErrorVocabulary(unittest.TestCase):
    """The error vocabulary is a wire contract, so it is pinned to the
    gateway's LIVE names rather than to our hopes. Twin of tests/errors.test.ts.

    WHY THIS EXISTS. v0.1.0 mapped refusals by looking up ``error.type`` alone,
    keyed on the gateway's ORIGINAL private names (``unauthorized``,
    ``invalid_request``, ``rate_limited``). The gateway has since moved to the
    INDUSTRY vocabulary — ``invalid_request_error`` for both a 401 and a 400,
    ``rate_limit_error`` for a 429 — which is right for portability and which
    silently broke the mapping: measured live against api.conifer.build on
    2026-08-27, a 401 and a 400 both arrived as a bare ``ConiferError`` and a
    429 lost its ``retry-after``. Three error classes were unreachable.

    The old fixtures used the retired names too, so code and test were wrong
    together. These drive the fixtures FROM the contract instead.
    """

    def test_a_live_401_is_an_auth_error(self):
        # The exact body a bogus bearer token returned on 2026-08-27.
        error = error_from(
            401,
            {
                "error": {
                    "type": "invalid_request_error",
                    "message": "Incorrect API key provided",
                    "code": "invalid_api_key",
                }
            },
            {},
        )
        self.assertIsInstance(error, ConiferAuthError)
        self.assertEqual(error.code, "invalid_api_key")
        self.assertFalse(error.retryable)

    def test_a_400_under_the_same_collapsed_type_is_a_bad_request(self):
        error = error_from(400, {"error": {"type": "invalid_request_error", "message": "bad"}}, {})
        self.assertIsInstance(error, ConiferBadRequestError)
        self.assertFalse(error.retryable)

    def test_a_429_keeps_its_class_and_the_servers_retry_after(self):
        # Under the old mapping this fell to the status-based default, which is
        # still retryable — so the bug was invisible in aggregate while throwing
        # away the server's own hint and backing off on a blind guess instead.
        error = error_from(
            429,
            {"error": {"type": "rate_limit_error", "message": "slow down"}},
            {"retry-after": "7"},
        )
        self.assertIsInstance(error, ConiferRateLimitError)
        self.assertEqual(error.retry_after_seconds, 7)
        self.assertTrue(error.retryable)

    def test_the_three_402s_are_three_classes_with_three_remedies(self):
        account = error_from(402, {"error": {"type": "insufficient_allowance", "message": "x"}}, {})
        request = error_from(402, {"error": {"type": "cost_ceiling_exceeded", "message": "x"}}, {})
        key = error_from(402, {"error": {"type": "key_spend_cap_exceeded", "message": "x"}}, {})

        self.assertIsInstance(account, ConiferPaymentError)
        self.assertIsInstance(request, ConiferCostCeilingError)
        self.assertIsInstance(key, ConiferKeySpendCapError)
        # None is a sibling of another, so an isinstance check cannot confuse
        # "the account is empty" with "this key is done".
        self.assertNotIsInstance(key, ConiferPaymentError)
        self.assertNotIsInstance(key, ConiferCostCeilingError)
        self.assertNotIsInstance(account, ConiferKeySpendCapError)
        for error in (account, request, key):
            self.assertFalse(error.retryable)

    def test_every_error_type_in_the_contract_maps_to_a_specific_class(self):
        # `internal_error` is deliberately NOT given a bespoke class: a 500 is
        # the gateway's bug, and the only correct client behavior is the retry
        # the status-based default already provides.
        exempt = {"internal_error"}
        status_for = {
            "invalid_request_error": 400,
            "rate_limit_error": 429,
            "model_not_found": 404,
            "job_not_found": 404,
            "insufficient_allowance": 402,
            "cost_ceiling_exceeded": 402,
            "key_spend_cap_exceeded": 402,
            "request_in_progress": 409,
            "unknown_provider": 404,
            "byok_key_rejected": 422,
            "service_unavailable": 503,
            "upstream_error": 502,
            "wire_upstream_mismatch": 422,
        }
        for type_ in _contract()["error_envelope"]["types"]:
            if type_ in exempt:
                continue
            self.assertIn(type_, status_for, f"contract type {type_} has no status here")
            error = error_from(status_for[type_], {"error": {"type": type_, "message": "x"}}, {})
            self.assertIsNot(
                type(error),
                ConiferError,
                f"{type_} fell through to the bare ConiferError — class it or exempt it",
            )
            # The gateway's own word survives our class names.
            self.assertEqual(error.type, type_)

    def test_the_retired_type_names_still_map_to_the_same_classes(self):
        # An older deploy, or a recorded fixture, must not change meaning.
        self.assertIsInstance(
            error_from(401, {"error": {"type": "unauthorized", "message": "x"}}, {}),
            ConiferAuthError,
        )
        self.assertIsInstance(
            error_from(400, {"error": {"type": "invalid_request", "message": "x"}}, {}),
            ConiferBadRequestError,
        )
        limited = error_from(
            429, {"error": {"type": "rate_limited", "message": "x"}}, {"retry-after": "3"}
        )
        self.assertIsInstance(limited, ConiferRateLimitError)
        self.assertEqual(limited.retry_after_seconds, 3)

    def test_an_unrecognized_type_keeps_the_gateways_words(self):
        future = error_from(400, {"error": {"type": "some_future_type", "message": "new"}}, {})
        self.assertEqual(future.type, "some_future_type")
        self.assertEqual(future.message, "new")
        self.assertFalse(future.retryable)
        # A 5xx we have no name for is still worth one retry.
        self.assertTrue(
            error_from(500, {"error": {"type": "some_future_type", "message": "x"}}, {}).retryable
        )

    def test_a_409_that_says_retry_shortly_is_retryable(self):
        """The three 409s, and why one must NOT be retried.

        Found by the live QA harness rather than by reading: a run hit
        ``replayed_no_body_unresolved`` on a FIRST call and the SDK reported a
        hard failure, for a turn the gateway had explicitly invited it to
        re-ask. The status code cannot separate these cases — only the
        gateway's own wording can.
        """
        for message in (
            "this request is already in progress; retry shortly",
            "this request has no replayable response; retry shortly",
        ):
            error = error_from(
                409, {"error": {"type": "request_in_progress", "message": message}}, {}
            )
            self.assertIsInstance(error, ConiferConflictError)
            self.assertTrue(error.retryable, message)

        # Reusing a key for DIFFERENT bytes is terminal: the same request will
        # be refused identically forever, so retrying is pure latency.
        terminal = error_from(
            409,
            {
                "error": {
                    "type": "request_in_progress",
                    "message": "idempotency key was already used with a different request body",
                }
            },
            {},
        )
        self.assertIsInstance(terminal, ConiferConflictError)
        self.assertFalse(terminal.retryable)

    def test_a_transient_409_is_retried_reusing_the_idempotency_key(self):
        calls, transport = scripted(
            (
                409,
                {},
                {
                    "error": {
                        "type": "request_in_progress",
                        "message": "this request has no replayable response; retry shortly",
                    }
                },
            ),
            (200, RECEIPT_HEADERS, COMPLETION),
        )
        answer = Conifer(api_key="k", transport=transport, max_retries=2).chat(
            ChatRequest(model="m", messages=[])
        )
        self.assertEqual(len(calls), 2, "the transient conflict should have been retried")
        # THE safety property: the same key both times, so the retry cannot
        # bill a second turn even if the first had actually settled.
        self.assertEqual(
            calls[0]["headers"]["idempotency-key"], calls[1]["headers"]["idempotency-key"]
        )
        self.assertEqual(answer.text, "pinecone")

    def test_a_body_conflict_409_is_not_retried(self):
        calls, transport = scripted(
            (
                409,
                {},
                {
                    "error": {
                        "type": "request_in_progress",
                        "message": "idempotency key was already used with a different request body",
                    }
                },
            )
        )
        with self.assertRaises(ConiferConflictError):
            Conifer(api_key="k", transport=transport, max_retries=3).chat(
                ChatRequest(model="m", messages=[])
            )
        self.assertEqual(len(calls), 1, "a body conflict must not be retried")

    def test_a_transient_409_waits_long_enough_to_converge(self):
        # The default schedule (0.25s, 0.5s) gives a retryable failure 0.75s of
        # total patience, which is right for a 502 and far too impatient for a
        # 409: that one waits on CROSS-REPLICA CONVERGENCE, not on a socket.
        # Found in a fresh-install consumer test — i.e. exactly where a new
        # user would have found it, on their first call, for a turn that was
        # actually being served.
        self.assertGreaterEqual(minimum_backoff_seconds(409), 1.0)
        # Every other status keeps the fast schedule: a blip recovers fast.
        for status in (429, 502, 503, 504):
            self.assertEqual(minimum_backoff_seconds(status), 0.0, f"{status} slowed down")
        self.assertGreaterEqual(minimum_backoff_seconds(409) * 2, 3.0)

    def test_both_languages_agree_on_the_class_for_every_contract_type(self):
        """Parity, checked against the TypeScript names rather than assumed.

        The "one SDK, two languages" claim is only real if a Python service and
        a TypeScript app get the SAME class for the same refusal. The card names
        the classes; this checks Python actually produces those names.
        """
        card = json.loads(
            (Path(__file__).resolve().parents[2] / "cards/sdk.output.card.json").read_text()
        )
        documented = {
            name for name in card["errors"] if name.startswith("Conifer")
        }
        for name in documented:
            self.assertTrue(
                hasattr(sys.modules["conifer_sdk"], name),
                f"{name} is documented in the output card but not exported from conifer_sdk",
            )


class Embeddings(unittest.TestCase):
    """The embeddings door. Twin of tests/embeddings.test.ts.

    The base64 fixture is not invented: ``AACAPwAAAMAAAAA/`` is three
    little-endian float32s (1, -2, 0.5), checked by hand so the expectation
    does not depend on our own encoder.
    """

    RECEIPT = {
        "x-conifer-requested-model": "text-embedding-3-small",
        "x-conifer-effective-model": "text-embedding-3-small",
        "x-conifer-cost-nanousd": "40",
        "x-conifer-request-id": "gw-emb-1",
    }
    THREE_FLOATS = "AACAPwAAAMAAAAA/"

    def test_an_embeddings_turn_hits_its_door_and_returns_its_settled_cost(self):
        calls, transport = scripted(
            (
                200,
                self.RECEIPT,
                {
                    "object": "list",
                    "model": "text-embedding-3-small",
                    "data": [{"object": "embedding", "index": 0, "embedding": self.THREE_FLOATS}],
                    "usage": {"prompt_tokens": 2, "total_tokens": 2},
                },
            )
        )
        result = client(transport).embed(
            EmbeddingsRequest(model="text-embedding-3-small", input="hello world")
        )
        self.assertTrue(calls[0]["url"].endswith("/v1/embeddings"))
        self.assertEqual(calls[0]["method"], "POST")
        # Embeddings settle IN BAND — unlike a stream, the cost is right here.
        self.assertEqual(result.receipt.cost_nano_usd, 40)
        self.assertEqual(result.receipt.request_id, "gw-emb-1")
        # Input tokens only: there is no completion, so no completion_tokens.
        self.assertEqual(result.usage["prompt_tokens"], 2)
        self.assertNotIn("completion_tokens", result.usage)

    def test_base64_is_requested_by_default_and_decoded_for_the_caller(self):
        calls, transport = scripted(
            (200, self.RECEIPT, {"data": [{"index": 0, "embedding": self.THREE_FLOATS}]})
        )
        result = client(transport).embed(
            EmbeddingsRequest(model="text-embedding-3-small", input="hello world")
        )
        # The wire asked for base64 (3x smaller than a JSON float array) …
        self.assertEqual(calls[0]["body"]["encoding_format"], "base64")
        # … and the caller never has to know that.
        self.assertEqual(vector_of(result), [1.0, -2.0, 0.5])
        # The provider's own body survives untouched, base64 included.
        self.assertEqual(result.raw["data"][0]["embedding"], self.THREE_FLOATS)

    def test_float_is_honored_when_explicitly_asked_for(self):
        calls, transport = scripted(
            (200, self.RECEIPT, {"data": [{"index": 0, "embedding": [1.0, -2.0, 0.5]}]})
        )
        result = client(transport).embed(
            EmbeddingsRequest(
                model="text-embedding-3-small", input="hello world", encoding_format="float"
            )
        )
        self.assertEqual(calls[0]["body"]["encoding_format"], "float")
        # Same numbers either way. That property is what makes the base64
        # default safe to apply silently.
        self.assertEqual(vector_of(result), [1.0, -2.0, 0.5])

    def test_a_batch_keeps_one_vector_per_input_in_order(self):
        _, transport = scripted(
            (
                200,
                self.RECEIPT,
                {"data": [{"index": i, "embedding": self.THREE_FLOATS} for i in range(3)]},
            )
        )
        result = client(transport).embed(
            EmbeddingsRequest(model="text-embedding-3-small", input=["alpha", "beta", "gamma"])
        )
        self.assertEqual([d.index for d in result.data], [0, 1, 2])
        for entry in result.data:
            self.assertEqual(entry.embedding, [1.0, -2.0, 0.5])

    def test_token_id_input_is_refused_before_any_spend(self):
        calls, transport = scripted()
        with self.assertRaises(ConiferPortabilityError) as caught:
            client(transport).embed(
                EmbeddingsRequest(model="text-embedding-3-small", input=[[1, 2, 3]])
            )
        self.assertEqual(caught.exception.field, "input")
        # The point of refusing client-side: no request was made at all.
        self.assertEqual(len(calls), 0)

    def test_the_body_carries_only_fields_this_door_has(self):
        body = embeddings_body(
            EmbeddingsRequest(
                model="text-embedding-3-large", input="hi", dimensions=256, user="user-1"
            )
        )
        self.assertEqual(
            body,
            {
                "model": "text-embedding-3-large",
                "input": "hi",
                "encoding_format": "base64",
                "dimensions": 256,
                "user": "user-1",
            },
        )
        # No max_tokens, no temperature, no stream: an embedding has no
        # completion, so those knobs would imply a control the wire lacks.
        for absent in ("max_tokens", "temperature", "top_p", "stream", "messages"):
            self.assertNotIn(absent, body)

    def test_ceiling_and_attribution_ride_as_headers_exactly_as_on_chat(self):
        headers = embeddings_headers(
            EmbeddingsRequest(
                model="m", input="hi", max_cost_nano_usd=1_000_000, client="my-app", request_id="r1"
            ),
            "idem-1",
        )
        self.assertEqual(headers["x-conifer-max-cost-nanousd"], "1000000")
        self.assertEqual(headers["x-conifer-client"], "my-app")
        self.assertEqual(headers["x-request-id"], "r1")
        # Every POST is idempotent, so a transport retry cannot bill twice.
        self.assertEqual(headers["idempotency-key"], "idem-1")

    def test_a_fractional_ceiling_is_refused_rather_than_rounded(self):
        with self.assertRaises(ConiferPortabilityError):
            embeddings_headers(
                EmbeddingsRequest(model="m", input="hi", max_cost_nano_usd=1.5), "idem-1"
            )

    def test_decode_refuses_to_guess_at_an_unrecognized_shape(self):
        # A WRONG vector is far worse than a missing one: it sails through a
        # cosine similarity and returns nonsense rankings forever.
        for junk in ("!!!not base64!!!", None, 42, "AAA="):
            self.assertEqual(decode_vector(junk), [])
        # And the shapes it DOES recognize still work.
        self.assertEqual(decode_vector(self.THREE_FLOATS), [1.0, -2.0, 0.5])
        self.assertEqual(decode_vector([1, 2, 3]), [1.0, 2.0, 3.0])

    def test_decoding_is_little_endian_regardless_of_the_host(self):
        # Stated explicitly ("<") rather than inherited, so this decodes the
        # same on a big-endian machine.
        self.assertEqual(decode_vector("AACAPw=="), [1.0])

    def test_both_languages_decode_the_same_bytes_to_the_same_vector(self):
        """Parity on the one payload whose numbers ARE the product.

        Measured live on 2026-08-27: this is the first vector
        `text-embedding-3-small` returned for "hello world", and the
        TypeScript twin decodes the identical values from the identical bytes.
        """
        # The first 12 bytes (3 float32s) of the vector the live gateway
        # returned, copied off the wire rather than hand-assembled.
        live_prefix = "AKDeuwCAIL0AwAs9"
        self.assertEqual(
            [round(x, 9) for x in decode_vector(live_prefix)],
            [-0.006793976, -0.03918457, 0.034118652],
        )

    def test_an_empty_vector_list_does_not_invent_a_vector(self):
        _, transport = scripted((200, self.RECEIPT, {"data": []}))
        result = client(transport).embed(EmbeddingsRequest(model="m", input="hi"))
        self.assertEqual(result.data, [])
        self.assertIsNone(vector_of(result))


class RequestIdentity(unittest.TestCase):
    """``request_id`` used to be inert, and that is worth a test of its own.

    The gateway derives its request id from the FIRST of ``idempotency-key``
    then ``x-request-id`` (its own ``request_id()``, confirmed live
    2026-08-27). Because the SDK always sends an idempotency key, the second
    name was never once reached: a caller who set ``request_id`` to their trace
    id got a generated ``idem-<uuid>`` back in the receipt and could not
    correlate a support question with their own logs. On this gateway the two
    are ONE identity, so the SDK feeds ``request_id`` into the key that is
    actually read. Twin of the same assertions in tests/client.test.ts.
    """

    def test_an_explicit_request_id_becomes_the_id_the_gateway_echoes(self):
        calls, transport = scripted(
            (200, {"x-conifer-request-id": "trace-42"}, COMPLETION)
        )
        answer = client(transport).chat(
            ChatRequest(model="m", messages=[], request_id="trace-42")
        )
        # The header the gateway READS carries the caller's id …
        self.assertEqual(calls[0]["headers"]["idempotency-key"], "trace-42")
        # … and the one it merely logs carries it too, for anything between.
        self.assertEqual(calls[0]["headers"]["x-request-id"], "trace-42")
        # So the id the caller chose is the id that comes back.
        self.assertEqual(answer.receipt.request_id, "trace-42")

    def test_an_explicit_idempotency_key_still_wins(self):
        # The two remain separable: idempotency is about not billing twice, and
        # a caller whose trace ids are not unique per turn must be able to say so.
        calls, transport = scripted((200, {}, COMPLETION))
        client(transport).chat(
            ChatRequest(model="m", messages=[], request_id="trace-42", idempotency_key="key-1")
        )
        self.assertEqual(calls[0]["headers"]["idempotency-key"], "key-1")
        self.assertEqual(calls[0]["headers"]["x-request-id"], "trace-42")

    def test_with_neither_id_the_turn_is_still_idempotent(self):
        calls, transport = scripted((200, {}, COMPLETION))
        client(transport).chat(ChatRequest(model="m", messages=[]))
        # A retry that cannot double-bill is the whole point, so the key is
        # never optional — only its SOURCE is.
        self.assertTrue(calls[0]["headers"]["idempotency-key"].startswith("idem-"))
        self.assertNotIn("x-request-id", calls[0]["headers"])

    def test_the_embeddings_door_resolves_identity_the_same_way(self):
        calls, transport = scripted((200, {}, {"data": []}))
        client(transport).embed(
            EmbeddingsRequest(model="text-embedding-3-small", input="hi", request_id="trace-9")
        )
        self.assertEqual(calls[0]["headers"]["idempotency-key"], "trace-9")


class DeferredJobs(unittest.TestCase):
    """The deferred-job plane. Twin of tests/deferred.test.ts.

    WHY THIS EXISTS. The SDK accepted ``defer=True`` from the start and had no
    way to collect the result. Worse than missing: the gateway answers a
    deferred submit with 202 and a JOB ENVELOPE, which ``chat()`` coerced into
    a Completion — so a turn that had been accepted AND DEBITED came back as
    ``choices=[]``, indistinguishable at the call site from a model that
    answered with nothing.

    Every status string below was observed against api.conifer.build on
    2026-08-27, including a full round trip: queued -> submitted -> ended ->
    (fetch) -> fetched, settling at 470000 nanodollars.
    """

    ACCEPTED = {
        "job_id": "job-gw-abc",
        "status": "queued",
        "deadline_utc": 1787900264,
        "poll_url": "/v1/deferred/job-gw-abc",
    }

    def test_chat_refuses_a_deferred_turn_rather_than_returning_nothing(self):
        calls, transport = scripted()
        with self.assertRaises(ConiferPortabilityError) as caught:
            client(transport).chat(ChatRequest(model="m", messages=[], defer=True))
        self.assertEqual(caught.exception.field, "defer")
        # The message must name the way forward, not just the problem.
        self.assertIn("defer()", caught.exception.message)
        # Refused before the request: no money moved to produce this error.
        self.assertEqual(len(calls), 0)

    def test_defer_submits_with_the_gateways_floor_and_returns_the_job(self):
        calls, transport = scripted((202, {}, self.ACCEPTED))
        job = client(transport).defer(ChatRequest(model="m", messages=[]))
        body = calls[0]["body"]
        self.assertEqual(body["defer"], "allow")
        # The gateway REFUSES a narrower window, so defaulting to the floor is
        # what makes the common call work rather than 400.
        self.assertEqual(body["completion_window_seconds"], MIN_DEFER_WINDOW_SECONDS)
        self.assertEqual(calls[0]["headers"]["x-conifer-defer"], "allow")
        self.assertEqual(job.job_id, "job-gw-abc")
        self.assertEqual(job.status, "queued")

    def test_an_explicit_deadline_is_not_overwritten_by_the_floor(self):
        calls, transport = scripted((202, {}, self.ACCEPTED))
        client(transport).defer(ChatRequest(model="m", messages=[], deadline_seconds=172_800))
        self.assertEqual(calls[0]["body"]["completion_window_seconds"], 172_800)

    def test_a_fallback_chain_cannot_ride_a_deferred_job(self):
        calls, transport = scripted()
        with self.assertRaises(ConiferPortabilityError):
            client(transport).defer(
                ChatRequest(
                    model="m", messages=[], fallback_models=["b"], allow_client_fallback=True
                )
            )
        self.assertEqual(len(calls), 0)

    def test_status_result_and_cancel_hit_the_published_paths(self):
        calls, transport = scripted(
            (200, {}, {"job_id": "job-gw-abc", "status": "submitted", "model": "claude-fable-5"}),
            (
                200,
                {"x-conifer-cost-nanousd": "470000"},
                {"choices": [{"message": {"role": "assistant", "content": "pinecone"}}]},
            ),
            (200, {}, {"job_id": "job-gw-abc", "status": "cancelled"}),
        )
        conifer = client(transport)

        status = conifer.job_status("job-gw-abc")
        self.assertTrue(calls[0]["url"].endswith("/v1/deferred/job-gw-abc"))
        self.assertEqual(status.status, "submitted")

        answer = conifer.job_result("job-gw-abc")
        self.assertTrue(calls[1]["url"].endswith("/v1/deferred/job-gw-abc/result"))
        self.assertEqual(answer.text, "pinecone")
        # A deferred result settles in band, exactly like a non-streamed turn.
        self.assertEqual(answer.receipt.cost_nano_usd, 470_000)

        cancelled = conifer.job_cancel("job-gw-abc")
        self.assertTrue(calls[2]["url"].endswith("/v1/deferred/job-gw-abc/cancel"))
        self.assertEqual(calls[2]["method"], "POST")
        self.assertEqual(cancelled.status, "cancelled")

    def test_a_job_id_is_escaped_so_it_cannot_walk_out_of_its_path(self):
        calls, transport = scripted((200, {}, {"job_id": "x", "status": "queued"}))
        client(transport).job_status("../../v1/balance")
        self.assertFalse(calls[0]["url"].endswith("/v1/balance"))

    def test_wait_polls_to_the_end_and_returns_the_settled_result(self):
        calls, transport = scripted(
            (200, {}, {"job_id": "j", "status": "queued"}),
            (200, {}, {"job_id": "j", "status": "submitted"}),
            (200, {}, {"job_id": "j", "status": "ended"}),
            (
                200,
                {"x-conifer-cost-nanousd": "470000"},
                {"choices": [{"message": {"role": "assistant", "content": "pinecone"}}]},
            ),
        )
        seen = []
        answer = client(transport).jobs_wait(
            "j", poll_seconds=0.001, on_poll=lambda job: seen.append(job.status)
        )
        # The live sequence, condensed.
        self.assertEqual(seen, ["queued", "submitted", "ended"])
        self.assertEqual(answer.text, "pinecone")
        self.assertEqual(answer.receipt.cost_nano_usd, 470_000)
        self.assertEqual(len(calls), 4)

    def test_wait_stops_on_a_terminal_state_instead_of_polling_forever(self):
        # The loop-that-cannot-exit bug, prevented by construction.
        for status in ("cancelled", "failed", "expired"):
            calls, transport = scripted((200, {}, {"job_id": "j", "status": status}))
            with self.assertRaises(ConiferConflictError) as caught:
                client(transport).jobs_wait("j", poll_seconds=0.001)
            self.assertIn(status, caught.exception.message)
            # Exactly one poll: it learned the answer and stopped.
            self.assertEqual(len(calls), 1, f"{status} must not be polled twice")

    def test_wait_honors_a_timeout_without_cancelling_paid_work(self):
        calls, transport = scripted((200, {}, {"job_id": "j", "status": "queued"}))
        with self.assertRaises(ConiferTimeoutError) as caught:
            client(transport).jobs_wait("j", poll_seconds=0.001, timeout_seconds=0)
        # The message must say the job survived, or a reader will assume the
        # opposite and re-submit work they have already paid for.
        self.assertIn("NOT cancelled", caught.exception.message)
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(c["url"].endswith("/cancel") for c in calls))

    def test_the_terminal_set_matches_the_gateways_state_machine(self):
        # `ended` is deliberately NOT terminal: it is the state where a result
        # becomes fetchable, and treating it as an end would skip collecting it.
        self.assertEqual(TERMINAL_JOB_STATUSES, ("fetched", "expired", "cancelled", "failed"))
        self.assertFalse(is_terminal_job("ended"))
        self.assertFalse(is_terminal_job("queued"))
        self.assertTrue(is_terminal_job("fetched"))
        self.assertFalse(is_terminal_job(None))

    def test_the_job_envelope_parses_without_losing_what_was_sent(self):
        job = to_deferred_job({**self.ACCEPTED, "surprise_field": 1})
        self.assertEqual(job.job_id, "job-gw-abc")
        self.assertEqual(job.poll_url, "/v1/deferred/job-gw-abc")
        # Nothing the gateway said is dropped behind our field names.
        self.assertEqual(job.raw["surprise_field"], 1)


class Receipts(unittest.TestCase):
    """Receipts for the client you ALREADY use. Twin of tests/receipts.test.ts.

    The exact per-turn cost is the one thing Conifer has that other gateways do
    not, and it rides the RESPONSE HEADERS — which every mainstream client
    throws away. This collector reads them off any response-like object, so a
    team keeps their existing ``openai`` client and still sees the money.
    """

    #: The receipt headers a real chat turn carries, measured 2026-08-27.
    RECEIPT = {
        "x-conifer-effective-model": "claude-fable-5",
        "x-conifer-cost-nanousd": "580000",
        "x-conifer-cost-components-nanousd": "fresh=80000,cache_write=0,cache_read=0,output=500000",
        "x-conifer-request-id": "gw-1",
    }

    class FakeResponse:
        """Duck-typed like httpx.Response: headers + url, and NO body access."""

        def __init__(self, headers, url="https://api.conifer.build/v1/chat/completions"):
            self.headers = headers
            self.url = url

    def test_the_receipt_is_captured_off_headers_alone(self):
        rc = ReceiptCollector()
        rc.httpx_hook(self.FakeResponse(self.RECEIPT))
        self.assertEqual(rc.last.cost_nano_usd, 580_000)
        self.assertEqual(rc.last.effective_model, "claude-fable-5")
        self.assertEqual(rc.last.receipt.cost_components_nano_usd.fresh, 80_000)
        self.assertEqual(rc.last.url, "https://api.conifer.build/v1/chat/completions")

    def test_a_response_with_no_receipt_is_ignored_not_counted_as_free(self):
        # Not every call through a wrapped client is an inference turn — a
        # /models read, a health check. Counting those as zero-cost turns would
        # quietly deflate the average cost per turn.
        rc = ReceiptCollector()
        self.assertIsNone(rc.observe({"content-type": "application/json"}))
        self.assertEqual(rc.total.turns, 0)
        self.assertIsNone(rc.last)

    def test_the_total_sums_exactly_in_integers(self):
        rc = ReceiptCollector()
        rc.observe({**self.RECEIPT, "x-conifer-cost-nanousd": "580000"})
        rc.observe({**self.RECEIPT, "x-conifer-cost-nanousd": "590000"})
        total = rc.total
        self.assertEqual(total.turns, 2)
        # Integer nanodollars, never floating dollars: 0.00058 + 0.00059 in
        # floats is not 0.00117, and money that does not add up is worse than
        # no money.
        self.assertEqual(total.cost_nano_usd, 1_170_000)
        self.assertEqual(total.cost_usd, "0.001170000")

    def test_the_counterfactual_is_summed_over_its_own_subset(self):
        # The gateway omits this header unless the routed predicate holds, so a
        # naive sum invites comparing it against a cost drawn from more turns
        # and reporting a savings number that was never true.
        rc = ReceiptCollector()
        rc.observe({**self.RECEIPT, "x-conifer-counterfactual-nanousd": "900000"})
        rc.observe(self.RECEIPT)
        total = rc.total
        self.assertEqual(total.turns, 2)
        self.assertEqual(total.counterfactual_turns, 1, "the subset size must be visible")
        self.assertEqual(total.counterfactual_nano_usd, 900_000)

    def test_the_total_stays_exact_after_the_retention_cap_drops_receipts(self):
        # A spend figure that quietly stopped counting would be worse than none.
        rc = ReceiptCollector(retain=2)
        for _ in range(4):
            rc.observe(self.RECEIPT)
        self.assertEqual(len(rc.all), 2, "the retained tail is bounded")
        self.assertEqual(rc.total.turns, 4, "but the count is of every turn")
        self.assertEqual(rc.total.cost_nano_usd, 4 * 580_000)

    def test_a_throwing_callback_cannot_corrupt_the_total(self):
        # The caller already paid for that turn. Their bad metrics hook must
        # not turn a successful, billed inference call into a failure.
        def explode(_):
            raise RuntimeError("the caller's metrics backend is down")

        rc = ReceiptCollector(on_receipt=explode)
        rc.observe(self.RECEIPT)  # must not raise
        self.assertEqual(rc.total.cost_nano_usd, 580_000)

    def test_reset_clears_the_tail_and_the_total(self):
        rc = ReceiptCollector()
        rc.observe(self.RECEIPT)
        rc.reset()
        self.assertEqual(len(rc.all), 0)
        self.assertEqual(rc.total.turns, 0)
        self.assertEqual(rc.total.cost_nano_usd, 0)

    def test_the_collector_is_thread_safe(self):
        # An `openai` client is routinely shared across threads, and a spend
        # total that silently loses increments under concurrency would be
        # worse than no total at all.
        import threading

        rc = ReceiptCollector(retain=0)
        def hammer():
            for _ in range(200):
                rc.observe(self.RECEIPT)

        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(rc.total.turns, 1600)
        self.assertEqual(rc.total.cost_nano_usd, 1600 * 580_000)

    def test_a_spend_budget_refuses_the_next_call_once_spent(self):
        budget = SpendBudget(1_000_000)
        self.assertEqual(budget.remaining_nano_usd, 1_000_000)
        budget.check()  # under budget: fine

        budget.collector.observe(self.RECEIPT)  # 580000
        self.assertEqual(budget.remaining_nano_usd, 420_000)
        self.assertFalse(budget.exhausted)
        budget.check()  # still fine

        # The second turn crosses the line. It is NOT refused — the cost is
        # only known once it settles, which is why the worst case is
        # budget + one turn.
        budget.collector.observe(self.RECEIPT)
        self.assertTrue(budget.exhausted)
        self.assertEqual(budget.remaining_nano_usd, 0, "clamped, never negative")
        with self.assertRaises(SpendBudgetExceeded) as caught:
            budget.check()
        # The message must say the refusal was ours, or a reader will hunt for
        # a gateway 402 that never happened.
        self.assertIn("CLIENT-SIDE", str(caught.exception))

    def test_a_fractional_or_negative_budget_is_refused(self):
        with self.assertRaises(ValueError):
            SpendBudget(1.5)
        with self.assertRaises(ValueError):
            SpendBudget(-1)

class EmptyCompletions(unittest.TestCase):
    """The empty-completion trap. Twin of the same tests in client.test.ts.

    Measured live 2026-08-27 on BOTH wires: a reasoning model spends
    ``max_tokens`` on its thinking block FIRST, so a small budget is consumed
    before the visible answer starts. You get ``content: ""``,
    ``finish_reason: "length"``, and a bill for every one of those output
    tokens. `claude-fable-5` at max_tokens=16 does exactly this.

    That empty string is indistinguishable, at the call site, from a refusal, a
    content filter, or a broken SDK — and the distinguishing field is one most
    callers never read.
    """

    @staticmethod
    def _completion(choices, usage=None):
        return Completion(choices=choices, receipt=Receipt(), fallback_index=0, usage=usage)

    def test_an_empty_completion_explains_itself(self):
        truncated = self._completion(
            [{"finish_reason": "length", "message": {"role": "assistant", "content": ""}}]
        )
        why = truncated.empty_reason
        self.assertIn("max_tokens", why)
        self.assertIn("thinking block is spent FIRST", why)

        # With the reasoning breakdown it gets specific about where the budget
        # actually went.
        detailed = self._completion(
            [{"finish_reason": "length", "message": {"content": ""}}],
            usage={"completion_tokens": 20, "completion_tokens_details": {"reasoning_tokens": 20}},
        )
        self.assertIn("20 of 20 output tokens went to thinking", detailed.empty_reason)

    def test_a_completion_with_text_has_nothing_to_explain(self):
        fine = self._completion(
            [{"finish_reason": "stop", "message": {"content": "pinecone"}}]
        )
        self.assertIsNone(fine.empty_reason)

    def test_a_tool_call_is_an_answer_not_an_absence(self):
        # Empty text beside a tool call is CORRECT; calling it a failure would
        # send people chasing a bug in the one case working as designed.
        tool = self._completion(
            [
                {
                    "finish_reason": "tool_calls",
                    "message": {"content": None, "tool_calls": [{"id": "1"}]},
                }
            ]
        )
        self.assertIsNone(tool.empty_reason)

    def test_a_filter_and_a_no_choices_body_are_named(self):
        filtered = self._completion(
            [{"finish_reason": "content_filter", "message": {"content": ""}}]
        )
        # Worth stating plainly: the filter is the PROVIDER's, not ours.
        self.assertIn("applies no moderation of its own", filtered.empty_reason)

        # The shape a deferred 202 used to be coerced into. Point at the fix.
        self.assertIn("defer()", self._completion([]).empty_reason)


#: OpenRouter's OWN request-field list, transcribed from their published schema
#: on 2026-08-27. Not ours — that is the entire point: every other portability
#: test checks the shim against OUR card, which cannot catch the failure that
#: actually happened (the vendor's API grew fields our card never heard of, and
#: the converter dropped each one without a word).
OPENROUTER_REQUEST_FIELDS = (
    # Converted to a real Conifer input.
    "messages", "model", "response_format", "stop", "stream", "max_tokens",
    "temperature", "tools", "tool_choice", "top_p", "models", "user",
    # Refused: a server feature Conifer does not have.
    "prompt", "plugins", "route", "provider",
    # Unmodelled: forwarded only under an explicit opt-in.
    "seed", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty",
    "logit_bias", "top_logprobs", "min_p", "top_a", "prediction", "debug",
)


class OpenRouterDrift(unittest.TestCase):
    """The anti-drift gate. Twin of the same test in portability.test.ts.

    Five fields were being silently dropped until this list was checked against
    the vendor's schema: frequency_penalty, presence_penalty, top_logprobs,
    prediction and debug. Silent dropping violates the first law on the
    portability card, and a suite that only asks our own documents cannot see it.
    """

    def test_no_openrouter_request_field_is_silently_dropped(self):
        structural = {"messages", "model", "stream"}
        def sample(field):
            if field == "models":
                return ["b"]
            if field == "logit_bias":
                return {1: 1}
            return "x"

        for field in OPENROUTER_REQUEST_FIELDS:
            if field in structural:
                continue
            request = {"model": "m", "messages": [], field: sample(field)}
            try:
                converted = from_openrouter(
                    request, allow_client_fallback=True, passthrough_unknown=True
                )
            except ConiferPortabilityError:
                continue  # refused loudly: one of the three acceptable outcomes
            # Otherwise it must be VISIBLE somewhere in the result.
            survived = (
                sample(field) in converted.__dict__.values()
                or field in (converted.extra_body or {})
                or converted.client == sample(field)
                or converted.fallback_models == sample(field)
            )
            self.assertTrue(
                survived,
                f"OpenRouter's `{field}` was accepted and then SILENTLY DROPPED. Refuse it, "
                "or add it to _UNMODELLED — the one thing the card forbids is losing it "
                "quietly.",
            )

    def test_a_marketplace_only_header_refuses_instead_of_vanishing(self):
        # Conifer has no marketplace, so there is nothing for it to become —
        # and a lenient reading would return it as the app NAME, mislabelling
        # every turn's attribution.
        with self.assertRaises(ConiferPortabilityError):
            attribution_from_openrouter({"X-OpenRouter-Categories": "roleplay"})
        # The title headers DO have an equivalent, under either spelling.
        self.assertEqual(attribution_from_openrouter({"X-OpenRouter-Title": "a"}), "a")
        self.assertEqual(attribution_from_openrouter({"X-Title": "a"}), "a")
        self.assertEqual(
            attribution_from_openrouter({"HTTP-Referer": "https://x.com"}), "https://x.com"
        )


class VercelGatewayControls(unittest.TestCase):
    """The Vercel shim had the same silent-drop flaw as OpenRouter's.

    It refused ``order`` and ``only``, converted ``models``, and let every other
    ``providerOptions.gateway`` key fall out of the dict unremarked. For routing
    keys that is a quality regression nobody can trace. For ``zdr`` and
    ``dataCollection`` it is worse than a bug: those are PRIVACY constraints,
    the request still succeeds, nothing errors, and a promise the caller made to
    their own users has quietly stopped being kept.
    """

    CONTROLS = (
        "order", "only", "ignore", "sort", "allowFallbacks", "requireParameters",
        "require_parameters", "quantizations", "maxPrice", "dataCollection", "zdr",
    )

    def test_every_gateway_control_is_converted_or_refused(self):
        for key in self.CONTROLS:
            with self.assertRaises(ConiferPortabilityError, msg=key):
                from_vercel_provider_options({"gateway": {key: "x"}}, allow_client_fallback=True)

    def test_an_unknown_gateway_control_refuses_rather_than_vanishing(self):
        # The case that matters most for a shim that must survive the vendor
        # shipping something new: we cannot judge whether an unrecognized
        # control mattered, so we must not decide it did not on the caller's
        # behalf.
        with self.assertRaises(ConiferPortabilityError) as caught:
            from_vercel_provider_options({"gateway": {"someFutureControl": True}})
        self.assertIn("does not recognize", caught.exception.message)
        self.assertIn("someFutureControl", caught.exception.field)

    def test_the_privacy_controls_name_themselves_as_promises(self):
        # Wording matters more here than anywhere else in the shim: a reader
        # who skims must understand this is something they may have told THEIR
        # users.
        for key in ("zdr", "dataCollection"):
            with self.assertRaises(ConiferPortabilityError) as caught:
                from_vercel_provider_options({"gateway": {key: True}})
            self.assertIn("MUST NOT be dropped", caught.exception.message)
            self.assertIn("conifer.build/privacy", caught.exception.message)

    def test_what_the_shim_should_convert_still_converts(self):
        # A fail-closed rule is only correct if it does not break the paths that
        # were working.
        fields, passthrough = from_vercel_provider_options(
            {"gateway": {"models": ["b"]}, "anthropic": {"thinking": True}},
            allow_client_fallback=True,
        )
        self.assertEqual(fields["fallback_models"], ["b"])
        self.assertTrue(fields["allow_client_fallback"])
        self.assertEqual(passthrough, {"anthropic": {"thinking": True}})


class HeliconeHeaderCoverage(unittest.TestCase):
    """The Helicone shim had the flaw too — including on its privacy headers.

    ``Helicone-Omit-Request`` and ``Helicone-Omit-Response`` are the caller
    telling their observability layer NOT to retain prompts or completions.
    Both were being dropped: the request succeeded, nothing errored, and a
    commitment the caller may have made to their own users quietly stopped
    being kept. ``Helicone-Auth`` was dropped too, which is its own trap: it
    means the caller still believes they are proxying through Helicone.
    """

    def test_every_unrecognized_or_unhonorable_header_refuses(self):
        for header in (
            "Helicone-Omit-Request",
            "Helicone-Omit-Response",
            "Helicone-Auth",
            "Helicone-Retry-Enabled",
            "Helicone-Some-Future-Header",
        ):
            with self.assertRaises(ConiferPortabilityError, msg=header) as caught:
                from_helicone_headers({header: "v"})
            # Reported in canonical lowercase: HTTP headers are
            # case-insensitive, and the shim normalizes before matching so the
            # two spellings cannot behave differently.
            self.assertEqual(caught.exception.field, header.lower())

    def test_the_privacy_headers_name_themselves_as_promises(self):
        for header in ("Helicone-Omit-Request", "Helicone-Omit-Response"):
            with self.assertRaises(ConiferPortabilityError) as caught:
                from_helicone_headers({header: "true"})
            self.assertIn("MUST NOT be dropped", caught.exception.message)
            self.assertIn("conifer.build/privacy", caught.exception.message)

    def test_what_the_shim_should_convert_still_converts(self):
        fields, properties = from_helicone_headers(
            {
                "Helicone-User-Id": "user-1",
                "Helicone-Request-Id": "req-1",
                "Helicone-Property-App": "my-app",
                "Helicone-Cache-Enabled": "false",
            }
        )
        self.assertEqual(fields["client"], "user-1")
        self.assertEqual(fields["request_id"], "req-1")
        self.assertEqual(fields["prompt_cache"], "off")
        # Properties are handed BACK, not stored: Conifer keeps no property
        # index and the shim will not pretend it does.
        self.assertEqual(properties, {"app": "my-app"})


class CostOnTheBody(unittest.TestCase):
    """The settled cost rides the BODY as well as the headers.

    OpenRouter puts cost in ``usage.cost``; Conifer's is on
    ``x-conifer-cost-nanousd``. Every logging pipeline, request recorder,
    LangChain/LiteLLM callback and JSON-dumping debug line keeps the body and
    discards the headers — so a team migrating from OpenRouter loses their cost
    column and the fix is somewhere they are not looking.

    It matters more here than elsewhere: a normal caller cannot read their usage
    history back (``/admin/usage/*`` is owner-only), so the receipt on the turn
    is their only record of what they spent. Twin of the same tests in
    client.test.ts.
    """

    def test_the_cost_is_copied_onto_usage_matching_the_header(self):
        usage = with_cost(
            {"prompt_tokens": 8, "completion_tokens": 34},
            Receipt(cost_nano_usd=1_780_000),
        )
        # Integer nanodollars are the authority; `cost` is the
        # OpenRouter-shaped decimal-USD float existing code already reads.
        self.assertEqual(usage["cost_nanousd"], 1_780_000)
        self.assertAlmostEqual(usage["cost"], 0.00178)
        # Nothing the gateway sent is disturbed.
        self.assertEqual(usage["prompt_tokens"], 8)
        self.assertEqual(usage["completion_tokens"], 34)

    def test_no_disclosed_cost_means_no_cost_field(self):
        # The stream case: the head is sent before the first token, so the cost
        # headers are genuinely absent. Inventing a 0 would tell every
        # dashboard the turn was free.
        usage = with_cost({"prompt_tokens": 8}, Receipt())
        self.assertNotIn("cost", usage)
        self.assertNotIn("cost_nanousd", usage)
        self.assertEqual(usage, {"prompt_tokens": 8})
        # Absent usage stays absent rather than becoming a cost-only object.
        self.assertIsNone(with_cost(None, Receipt()))

    def test_a_server_sent_cost_always_wins(self):
        # Additive only: if the gateway ever sends its own usage.cost, that is
        # the authoritative number.
        usage = with_cost({"cost": 0.42}, Receipt(cost_nano_usd=1_780_000))
        self.assertEqual(usage["cost"], 0.42)
        self.assertNotIn("cost_nanousd", usage, "no half-overwrite either")

    def test_a_completion_carries_the_cost_in_its_body(self):
        _, transport = scripted((200, RECEIPT_HEADERS, COMPLETION))
        answer = client(transport).chat(ChatRequest(model="m", messages=[]))
        # Same number, two places: whichever half of the response a tool keeps.
        self.assertEqual(answer.usage["cost_nanousd"], answer.receipt.cost_nano_usd)
        self.assertEqual(answer.usage["cost_nanousd"], 1_250_000)


if __name__ == "__main__":
    unittest.main()
