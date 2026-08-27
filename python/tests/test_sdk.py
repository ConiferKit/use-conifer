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
    ConiferError,
    ConiferKeySpendCapError,
    ConiferModelNotFoundError,
    ConiferPaymentError,
    ConiferPortabilityError,
    ConiferRateLimitError,
    ceiling_from_policy,
    conifer_openai_compatible_config,
    from_helicone_headers,
    from_openrouter,
    from_vercel_provider_options,
    nano_usd_to_usd_string,
    parse_fallbacks,
    read_receipt,
    resolve_base_url,
)
from conifer_sdk.client import (  # noqa: E402
    chat_body,
    parse_frame,
    chat_headers,
    pick_cheapest,
    resolve_chain,
)
from conifer_sdk.errors import error_from  # noqa: E402
from conifer_sdk.portability import assert_supported_vercel_surface  # noqa: E402
from conifer_sdk.receipt import parse_cost_components  # noqa: E402
from conifer_sdk.types import CatalogModel, ChatRequest  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
