// portability/vercel.ts — the Vercel AI Gateway / AI SDK migration path.
//
// Vercel's gateway speaks the OpenAI wire at https://ai-gateway.vercel.sh/v1,
// which is the same wire Conifer serves. So most of this is a URL and a key,
// and the honest work is in the two places it is NOT:
//
//   · `providerOptions.gateway` (order, models) — provider pinning and
//     server-side fallbacks, neither of which Conifer's admission model has.
//   · image generation — a door Conifer does not serve at all. (`/embeddings`
//     WAS listed here; the gateway shipped it on 2026-08-26, so the shim no
//     longer refuses that surface.)
//
// Both throw. See cards/portability.card.json.

import { ConiferPortabilityError } from "../errors.ts";
import { DEFAULT_BASE_URL } from "../client.ts";
import type { ChatRequest } from "../types.ts";

/** The OpenAI-compatible door, which is what every AI SDK provider wants. */
export function coniferOpenAICompatibleConfig(options: {
  apiKey?: string;
  baseUrl?: string;
  client?: string;
} = {}): { name: string; baseURL: string; apiKey: string; headers: Record<string, string> } {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};
  const apiKey = options.apiKey ?? env.CONIFER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new ConiferPortabilityError(
      "apiKey",
      "CONIFER_API_KEY is missing. Unlike Vercel's OIDC path there is no ambient credential to fall back on: supply the key.",
    );
  }
  const headers: Record<string, string> = {};
  if (options.client !== undefined) headers["x-conifer-client"] = options.client;
  return {
    // The AI SDK uses `name` only for provider-namespaced telemetry.
    name: "conifer",
    baseURL: `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1`,
    apiKey,
    headers,
  };
}

/** What a Vercel `providerOptions` bag may carry, as far as this shim reads. */
export interface VercelProviderOptions {
  gateway?: {
    /** Provider pinning. No Conifer equivalent. */
    order?: string[];
    /** Server-side model fallbacks. Becomes a client-side chain, opt-in. */
    models?: string[];
    only?: string[];
    [extra: string]: unknown;
  };
  [provider: string]: unknown;
}

/**
 * `providerOptions` -> the Conifer request fields it implies.
 *
 * Per-provider blocks OTHER than `gateway` (e.g. `anthropic: {...}`) are
 * returned for you to place in `extraBody`: Conifer forwards unmodelled body
 * fields to the upstream verbatim, so a provider-native option can still ride
 * along — but you place it deliberately, rather than the shim guessing that
 * every upstream understands it.
 */
export function fromVercelProviderOptions(
  providerOptions: VercelProviderOptions,
  options: { allowClientFallback?: boolean } = {},
): { request: Partial<ChatRequest>; passthrough: Record<string, unknown> } {
  const gateway = providerOptions.gateway ?? {};
  if (gateway.order !== undefined || gateway.only !== undefined) {
    throw new ConiferPortabilityError(
      "providerOptions.gateway.order",
      "provider pinning has no Conifer equivalent: the gateway picks the host for the admitted model by price and health, and the model you named is always the model you are charged for. Use `maxCostNanoUsd` if the goal was cost control.",
    );
  }
  const request: Partial<ChatRequest> = {};
  if (gateway.models !== undefined) {
    request.fallbackModels = gateway.models;
    request.allowClientFallback = options.allowClientFallback;
  }
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerOptions)) {
    if (key !== "gateway") passthrough[key] = value;
  }
  return { request, passthrough };
}

/**
 * Refuse, at the CALL SITE, a surface this gateway does not serve.
 *
 * The alternative is a 404 at runtime, in production, with a provider name in
 * it and no indication of what to do — which is exactly how a migration
 * "succeeds" and then fails on the one code path nobody exercised. Every entry
 * below was probed against api.conifer.build on 2026-08-27; the gateway's own
 * 404 prose is the source for each remedy.
 *
 * Note what is NOT here: `embeddings`. It was listed until the gateway shipped
 * `/v1/embeddings` on 2026-08-26, and the SDK now serves that door directly
 * (`conifer.embeddings.create`). A shim that refuses a surface the gateway
 * actually serves is as wrong as one that admits a surface it does not.
 */
export function assertSupportedVercelSurface(surface: string): void {
  const unsupported: Record<string, string> = {
    "image-generation":
      "Conifer serves no image-output door. Keep image generation on your current provider.",
    oidc:
      "there is no Conifer OIDC exchange. Mint a key at https://conifer.build/console#/keys and set CONIFER_API_KEY.",
    // Verified live 2026-08-27: each of these answers 404 with `unknown_url`.
    rerank:
      "Conifer does not serve reranking. The embedding models on this gateway (GET /v1/models, caps includes \"embeddings\") can rank by cosine similarity, or keep reranking on your current provider.",
    moderations:
      "Conifer serves no moderation door, and never silently applies one either — what you send is what runs. Keep moderation on your current provider.",
    audio:
      "Conifer serves no audio door (neither speech nor transcription). Keep audio on your current provider.",
    files:
      "Conifer serves no Files API. There is no server-side document store to upload to; send content in the request itself.",
    batches:
      "Conifer serves no Batches API. The nearest equivalent is the deferred-job protocol: set `defer: true` with a wide `deadlineSeconds` on a chat turn, and poll the job.",
  };
  // Aliases, so a caller who spells the surface the way THEIR old SDK spelled
  // it gets the explanation rather than silence.
  const aliases: Record<string, string> = {
    image: "image-generation",
    images: "image-generation",
    moderation: "moderations",
    reranking: "rerank",
    speech: "audio",
    transcription: "audio",
    "audio-speech": "audio",
    "audio-transcription": "audio",
    batch: "batches",
    file: "files",
  };
  const key = aliases[surface] ?? surface;
  const why = unsupported[key];
  if (why !== undefined) throw new ConiferPortabilityError(surface, why);
}

/** The env vars a Vercel-shaped app already sets, rewritten for Conifer. */
export function vercelEnvMigration(): Record<string, string> {
  return {
    // Vercel's own client reads AI_GATEWAY_API_KEY; the OpenAI-compatible
    // provider path reads whatever you pass it, so the honest instruction is
    // one variable and one base URL.
    CONIFER_API_KEY: "sk-conifer-…",
    OPENAI_BASE_URL: `${DEFAULT_BASE_URL}/v1`,
    OPENAI_API_KEY: "$CONIFER_API_KEY",
  };
}
