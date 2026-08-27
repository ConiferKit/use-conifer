// tests/portability.test.ts — the migration contract, tested as behavior.
//
// The assertions that matter most here are the NEGATIVE ones: a field Conifer
// cannot honor must THROW and name itself. A shim that quietly dropped a
// provider pin, a moderation flag, or a rate-limit policy would let a migration
// look clean while changing what runs and what it costs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ConiferPortabilityError,
  assertSupportedVercelSurface,
  attributionFromOpenRouter,
  ceilingFromPolicy,
  coniferOpenAICompatibleConfig,
  fromHeliconeHeaders,
  fromOpenRouter,
  fromVercelProviderOptions,
  parseFallbacks,
} from "../src/index.ts";

/** The migration contract itself, so the refusal list is driven FROM the card. */
const portability = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../cards/portability.card.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, any>;

function refuses(field: string, run: () => unknown) {
  const error = (() => {
    try {
      run();
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ConiferPortabilityError, `${field} must refuse, not drop`);
  assert.equal(error.field, field);
  assert.ok(error.message.length > 40, "a refusal must say what to do instead");
}

// ---------------------------------------------------------------- OpenRouter

test("an ordinary OpenRouter request converts field for field", () => {
  const converted = fromOpenRouter({
    model: "anthropic/claude-opus-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    temperature: 0.7,
    top_p: 0.9,
    stop: ["\n"],
    tools: [{ type: "function", function: { name: "f" } }],
    tool_choice: "auto",
    response_format: { type: "json_object" },
    user: "user-42",
  });
  assert.equal(converted.model, "anthropic/claude-opus-5", "vendor/model ids migrate untouched");
  assert.equal(converted.maxTokens, 100);
  assert.equal(converted.temperature, 0.7);
  assert.equal(converted.topP, 0.9);
  assert.deepEqual(converted.stop, ["\n"]);
  assert.equal(converted.toolChoice, "auto");
  assert.equal(converted.client, "user-42");
});

test("OpenRouter's server-side routing controls refuse rather than vanish", () => {
  const base = { model: "m", messages: [] };
  refuses("provider", () => fromOpenRouter({ ...base, provider: { order: ["anthropic"] } }));
  refuses("route", () => fromOpenRouter({ ...base, route: "fallback" }));
  refuses("plugins", () => fromOpenRouter({ ...base, plugins: [{ id: "web" }] }));
  refuses("transforms", () => fromOpenRouter({ ...base, transforms: ["middle-out"] }));
  refuses("prompt", () => fromOpenRouter({ ...base, prompt: "legacy" }));
});

test("`models` becomes an explicit, opt-in client-side chain", () => {
  const withoutOptIn = fromOpenRouter({ model: "a", messages: [], models: ["b", "c"] });
  // The conversion itself records the list; the CLIENT is what enforces the
  // opt-in, so the shim's job is to carry the flag through honestly.
  assert.deepEqual(withoutOptIn.fallbackModels, ["b", "c"]);
  assert.equal(withoutOptIn.allowClientFallback, undefined);

  const withOptIn = fromOpenRouter(
    { model: "a", messages: [], models: ["b"] },
    { allowClientFallback: true },
  );
  assert.equal(withOptIn.allowClientFallback, true);
});

test("unmodelled sampling knobs refuse unless explicitly passed through", () => {
  refuses("top_k", () => fromOpenRouter({ model: "m", messages: [], top_k: 40 }));
  const forwarded = fromOpenRouter(
    { model: "m", messages: [], top_k: 40, seed: 7 },
    { passthroughUnknown: true },
  );
  assert.deepEqual(forwarded.extraBody, { top_k: 40, seed: 7 });
});

test("a missing model refuses instead of inheriting an account default", () => {
  refuses("model", () => fromOpenRouter({ messages: [] }));
});

test("app-attribution headers map to caller attribution", () => {
  assert.equal(attributionFromOpenRouter({ "X-Title": "my app" }), "my app");
  assert.equal(attributionFromOpenRouter({ "HTTP-Referer": "https://x.dev" }), "https://x.dev");
  assert.equal(attributionFromOpenRouter({}), undefined);
});

// ------------------------------------------------------------------ Helicone

test("Helicone's observability headers map onto real Conifer inputs", () => {
  const { request, properties } = fromHeliconeHeaders({
    "Helicone-Request-Id": "123e4567-e89b-12d3-a456-426614174000",
    "Helicone-User-Id": "alice@example.com",
    "Helicone-Property-App": "mobile",
    "Helicone-Property-Env": "prod",
    "Helicone-Cache-Enabled": "false",
  });
  assert.equal(request.requestId, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(request.client, "alice@example.com");
  assert.equal(request.promptCache, "off");
  assert.deepEqual(properties, { app: "mobile", env: "prod" });
});

test("the cache header keeps the gateway's asymmetry: off is real, on is not", () => {
  refuses("helicone-cache-enabled", () =>
    fromHeliconeHeaders({ "Helicone-Cache-Enabled": "true" }),
  );
});

test("proxy-target and safety headers refuse loudly", () => {
  refuses("helicone-target-url", () =>
    fromHeliconeHeaders({ "Helicone-Target-URL": "https://api.openai.com" }),
  );
  refuses("helicone-moderations-enabled", () =>
    fromHeliconeHeaders({ "Helicone-Moderations-Enabled": "true" }),
  );
  refuses("helicone-llm-security-enabled", () =>
    fromHeliconeHeaders({ "Helicone-LLM-Security-Enabled": "true" }),
  );
  refuses("helicone-token-limit-exception-handler", () =>
    fromHeliconeHeaders({ "Helicone-Token-Limit-Exception-Handler": "middle-out" }),
  );
  refuses("helicone-prompt-id", () => fromHeliconeHeaders({ "Helicone-Prompt-Id": "p1" }));
  refuses("helicone-session-id", () => fromHeliconeHeaders({ "Helicone-Session-Id": "s1" }));
});

test("a cents rate-limit policy becomes a money ceiling; a request policy refuses", () => {
  assert.equal(ceilingFromPolicy("10;w=1000;u=cents;s=user"), 100_000_000);
  refuses("helicone-ratelimit-policy", () => ceilingFromPolicy("10;w=60;u=requests;s=user"));
  refuses("helicone-ratelimit-policy", () => ceilingFromPolicy("junk;w=60;u=cents"));
});

test("fallbacks parse from either shape and refuse a URL-pinned entry", () => {
  assert.deepEqual(parseFallbacks('["gpt-4o","claude-haiku-4-5"]'), [
    "gpt-4o",
    "claude-haiku-4-5",
  ]);
  assert.deepEqual(parseFallbacks('[{"model":"gpt-4o"}]'), ["gpt-4o"]);
  refuses("helicone-fallbacks", () => parseFallbacks('[{"target_url":"https://x"}]'));
  refuses("helicone-fallbacks", () => parseFallbacks("not json"));
});

test("a Helicone fallback list still needs the client-side opt-in", () => {
  const { request } = fromHeliconeHeaders({ "Helicone-Fallbacks": '["a","b"]' });
  assert.deepEqual(request.fallbackModels, ["a", "b"]);
  assert.equal(request.allowClientFallback, undefined, "never auto-accept extra billed calls");
});

// -------------------------------------------------------------------- Vercel

test("the AI SDK config points at the OpenAI-compatible door", () => {
  const config = coniferOpenAICompatibleConfig({ apiKey: "sk-conifer-x", client: "my-app" });
  assert.equal(config.baseURL, "https://api.conifer.build/v1");
  assert.equal(config.apiKey, "sk-conifer-x");
  assert.equal(config.headers["x-conifer-client"], "my-app");
});

test("there is no ambient credential to fall back on, unlike OIDC", () => {
  const saved = process.env.CONIFER_API_KEY;
  delete process.env.CONIFER_API_KEY;
  try {
    refuses("apiKey", () => coniferOpenAICompatibleConfig());
  } finally {
    if (saved !== undefined) process.env.CONIFER_API_KEY = saved;
  }
});

test("gateway provider pinning refuses; gateway model fallbacks convert", () => {
  refuses("providerOptions.gateway.order", () =>
    fromVercelProviderOptions({ gateway: { order: ["anthropic", "bedrock"] } }),
  );
  const { request, passthrough } = fromVercelProviderOptions(
    { gateway: { models: ["b"] }, anthropic: { thinking: { type: "enabled" } } },
    { allowClientFallback: true },
  );
  assert.deepEqual(request.fallbackModels, ["b"]);
  assert.equal(request.allowClientFallback, true);
  assert.deepEqual(passthrough, { anthropic: { thinking: { type: "enabled" } } });
});

test("doors Conifer does not serve fail at the call site, not at a 404", () => {
  refuses("image-generation", () => assertSupportedVercelSurface("image-generation"));
  refuses("oidc", () => assertSupportedVercelSurface("oidc"));
  // Probed live on 2026-08-27: each of these answers 404 `unknown_url`. A 404
  // in production, on the one code path nobody exercised, is exactly how a
  // migration "succeeds" and then fails.
  refuses("rerank", () => assertSupportedVercelSurface("rerank"));
  refuses("moderations", () => assertSupportedVercelSurface("moderations"));
  refuses("audio", () => assertSupportedVercelSurface("audio"));
  refuses("files", () => assertSupportedVercelSurface("files"));
  refuses("batches", () => assertSupportedVercelSurface("batches"));

  assert.doesNotThrow(() => assertSupportedVercelSurface("chat"));
  // The gateway shipped /v1/embeddings on 2026-08-26, so the shim must NOT
  // refuse it any more — a client that keeps throwing here would send people
  // to another provider for a door Conifer now serves.
  assert.doesNotThrow(() => assertSupportedVercelSurface("embeddings"));
});

test("a surface spelled the way another SDK spells it still gets the reason", () => {
  // Silence is the failure mode worth preventing: an unknown surface name
  // passes through, and the caller learns nothing until the 404.
  for (const alias of [
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
  ]) {
    refuses(alias, () => assertSupportedVercelSurface(alias));
  }
});

/**
 * The card is the contract, so the refusal list is driven FROM it. An entry
 * added to the card without a matching refusal in code (or the reverse) fails
 * here — which is the only thing that keeps a migration document honest as the
 * gateway's served surface changes.
 */
test("every unserved door the card names actually refuses, and the served ones do not", () => {
  const vercel = portability.vercel_ai_gateway;
  // The card's keys are prose ("audio (speech and transcription)"); the first
  // word is the surface token the shim is called with.
  const token = (label: string) => label.split(" ")[0]!.toLowerCase();
  for (const label of Object.keys(vercel.unsupported_refused)) {
    const surface = token(label);
    if (surface === "oidc") continue; // spelled the same, covered above
    assert.throws(
      () => assertSupportedVercelSurface(surface),
      ConiferPortabilityError,
      `the card refuses "${label}" but assertSupportedVercelSurface("${surface}") does not`,
    );
  }
  // And the inverse: a door the card records as NOW SERVED must not throw.
  for (const label of Object.keys(vercel.now_served)) {
    if (label === "note") continue;
    const surface = label.replace(/^POST \/+/, "");
    assert.doesNotThrow(
      () => assertSupportedVercelSurface(surface),
      `the card says ${label} is served, but the shim still refuses "${surface}"`,
    );
  }
});
