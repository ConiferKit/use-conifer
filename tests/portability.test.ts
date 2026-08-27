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

/**
 * THE ANTI-DRIFT GATE for OpenRouter's request schema.
 *
 * Every other test in this file checks the shim against OUR card, which cannot
 * catch the failure that actually happened: the vendor's API grew fields our
 * card never heard of, and `fromOpenRouter` — which converts a known list and
 * returns — dropped each one without a word. That is a direct violation of the
 * portability card's first law ("never silently drop a constraint"), and it was
 * invisible to a suite that only ever asked our own documents.
 *
 * Six fields were being dropped this way (checked against OpenRouter's
 * published request schema on 2026-08-27): `frequency_penalty`,
 * `presence_penalty`, `top_logprobs`, `prediction`, `debug`, and `user`.
 *
 * So this list is the VENDOR's, transcribed from their docs, and every member
 * must end up in exactly one of three states. A seventh field appearing in
 * their schema fails here until someone decides which state it belongs in.
 */
const OPENROUTER_REQUEST_FIELDS = [
  // Converted to a real Conifer input.
  "messages", "model", "response_format", "stop", "stream", "max_tokens",
  "temperature", "tools", "tool_choice", "top_p", "models", "user",
  // Refused: a server feature Conifer does not have.
  "prompt", "plugins", "route", "provider",
  // Unmodelled: forwarded only under an explicit opt-in.
  "seed", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty",
  "logit_bias", "top_logprobs", "min_p", "top_a", "prediction", "debug",
] as const;

test("no OpenRouter request field is silently dropped", () => {
  // Fields that are structural to the call and cannot be probed one at a time.
  const structural = new Set(["messages", "model", "stream"]);
  const sampleFor = (field: string): unknown =>
    field === "models" ? ["b"] : field === "logit_bias" ? { 1: 1 } : "x";

  for (const field of OPENROUTER_REQUEST_FIELDS) {
    if (structural.has(field)) continue;
    const request: Record<string, unknown> = {
      model: "m",
      messages: [],
      [field]: sampleFor(field),
    };

    let converted: Record<string, unknown> | undefined;
    try {
      // `models` needs its opt-in; `passthroughUnknown` reveals where an
      // unmodelled knob would land. Neither changes whether it is DROPPED.
      converted = fromOpenRouter(request, {
        allowClientFallback: true,
        passthroughUnknown: true,
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      // Refused loudly. That is one of the three acceptable outcomes.
      assert.ok(
        error instanceof ConiferPortabilityError,
        `${field} threw something that is not a portability error`,
      );
      continue;
    }

    // Otherwise it must be VISIBLE somewhere in the result — as a mapped
    // field, or in extraBody. Anywhere is fine; nowhere is the bug.
    const serialized = JSON.stringify(converted);
    const survived =
      serialized.includes(JSON.stringify(sampleFor(field))) ||
      (converted.extraBody as Record<string, unknown> | undefined)?.[field] !== undefined;
    assert.ok(
      survived,
      `OpenRouter's \`${field}\` was accepted and then SILENTLY DROPPED. Refuse it, or add it to UNMODELLED — the one thing the card forbids is losing it quietly.`,
    );
  }
});

test("a marketplace-only attribution header refuses instead of vanishing", () => {
  // `X-OpenRouter-Categories` assigns categories in OpenRouter's public model
  // marketplace. Conifer has no marketplace, so there is nothing for it to
  // become — and a lenient reading would return it as the app NAME, which
  // would mislabel every turn's attribution.
  refuses("X-OpenRouter-Categories", () =>
    attributionFromOpenRouter({ "X-OpenRouter-Categories": "roleplay" }),
  );

  // The title headers DO have an equivalent, under either spelling.
  assert.equal(attributionFromOpenRouter({ "X-OpenRouter-Title": "my-app" }), "my-app");
  assert.equal(attributionFromOpenRouter({ "X-Title": "my-app" }), "my-app");
  assert.equal(attributionFromOpenRouter({ "HTTP-Referer": "https://example.com" }), "https://example.com");
});

/**
 * The Vercel gateway shim had the same silent-drop flaw as OpenRouter's.
 *
 * It refused `order` and `only`, converted `models`, and let every other
 * `providerOptions.gateway` key fall out of the object unremarked. For routing
 * keys that is a quality regression nobody can trace. For `zdr` and
 * `dataCollection` it is worse than a bug: those are PRIVACY constraints, the
 * request still succeeds, nothing errors, and a promise the caller made to
 * their own users has quietly stopped being kept.
 */
test("every Vercel gateway control is converted or refused, never dropped", () => {
  const controls = [
    "order", "only", "ignore", "sort", "allowFallbacks", "requireParameters",
    "require_parameters", "quantizations", "maxPrice", "dataCollection", "zdr",
  ];
  for (const key of controls) {
    refuses(`providerOptions.gateway.${key}`, () =>
      fromVercelProviderOptions({ gateway: { [key]: "x" } }, { allowClientFallback: true }),
    );
  }
});

test("an UNKNOWN Vercel gateway control refuses rather than vanishing", () => {
  // The case that matters most for a shim that has to survive the vendor
  // shipping something new: we cannot judge whether an unrecognized control
  // mattered, so we must not decide on the caller's behalf that it did not.
  const error = (() => {
    try {
      fromVercelProviderOptions({ gateway: { someFutureControl: true } });
      return undefined;
    } catch (thrown) {
      return thrown as ConiferPortabilityError;
    }
  })();
  assert.ok(error instanceof ConiferPortabilityError, "an unknown control must refuse");
  assert.match(error.message, /does not recognize/);
  assert.match(error.field, /someFutureControl/);
});

test("the privacy controls name themselves as promises, not preferences", () => {
  // Wording matters here more than anywhere else in the shim: a reader who
  // skims must understand this is something they may have told THEIR users.
  for (const key of ["zdr", "dataCollection"]) {
    const error = (() => {
      try {
        fromVercelProviderOptions({ gateway: { [key]: true } });
        return undefined;
      } catch (thrown) {
        return thrown as ConiferPortabilityError;
      }
    })();
    assert.match(error?.message ?? "", /MUST NOT be dropped/);
    assert.match(error?.message ?? "", /conifer\.build\/privacy/);
  }
});

test("what the Vercel shim SHOULD convert still converts", () => {
  // A fail-closed rule is only correct if it does not also break the paths
  // that were working: `models` becomes an opt-in client-side chain, and other
  // providers' blocks pass through for deliberate placement in extraBody.
  const { request, passthrough } = fromVercelProviderOptions(
    { gateway: { models: ["b"] }, anthropic: { thinking: { type: "enabled" } } },
    { allowClientFallback: true },
  );
  assert.deepEqual(request.fallbackModels, ["b"]);
  assert.equal(request.allowClientFallback, true);
  assert.deepEqual(passthrough, { anthropic: { thinking: { type: "enabled" } } });
});

/**
 * The Helicone shim had the flaw too — including on its privacy headers.
 *
 * `Helicone-Omit-Request` and `Helicone-Omit-Response` are the caller telling
 * their observability layer NOT to retain prompts or completions. Both were
 * being dropped: the request succeeded, nothing errored, and a commitment the
 * caller may have made to their own users quietly stopped being kept.
 *
 * `Helicone-Auth` was dropped too, which is its own small trap: it means the
 * caller still believes they are proxying through Helicone.
 */
test("every unrecognized or unhonorable Helicone header refuses", () => {
  for (const header of [
    "Helicone-Omit-Request",
    "Helicone-Omit-Response",
    "Helicone-Auth",
    "Helicone-Retry-Enabled",
    "Helicone-Some-Future-Header",
  ]) {
    // Sent in the caller's casing, reported in the canonical lowercase — HTTP
    // headers are case-insensitive, and the shim normalizes before matching so
    // `Helicone-Auth` and `helicone-auth` cannot behave differently.
    refuses(header.toLowerCase(), () => fromHeliconeHeaders({ [header]: "v" }));
  }
});

test("the Helicone privacy headers name themselves as promises", () => {
  for (const header of ["Helicone-Omit-Request", "Helicone-Omit-Response"]) {
    const error = (() => {
      try {
        fromHeliconeHeaders({ [header]: "true" });
        return undefined;
      } catch (thrown) {
        return thrown as ConiferPortabilityError;
      }
    })();
    assert.match(error?.message ?? "", /MUST NOT be dropped/);
    assert.match(error?.message ?? "", /conifer\.build\/privacy/);
  }
});

test("what the Helicone shim SHOULD convert still converts", () => {
  // Fail-closed is only correct if it does not break the working paths.
  const { request, properties } = fromHeliconeHeaders({
    "Helicone-User-Id": "user-1",
    "Helicone-Request-Id": "req-1",
    "Helicone-Property-App": "my-app",
    "Helicone-Cache-Enabled": "false",
  });
  assert.equal(request.client, "user-1");
  assert.equal(request.requestId, "req-1");
  assert.equal(request.promptCache, "off");
  // Properties are handed BACK, not stored: Conifer keeps no property index
  // and the shim will not pretend it does.
  assert.deepEqual(properties, { app: "my-app" });
});
