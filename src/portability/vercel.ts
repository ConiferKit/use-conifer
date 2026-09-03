// The Vercel AI Gateway and AI SDK migration path. Vercel speaks the same
// OpenAI wire, so most of this is a URL and a key. `providerOptions.gateway`
// controls Conifer does not have, and surfaces it does not serve, throw.

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
      "CONIFER_API_KEY is missing. There is no ambient credential to fall back on: supply the key.",
    );
  }
  const headers: Record<string, string> = {};
  if (options.client !== undefined) headers["x-conifer-client"] = options.client;
  return {
    name: "conifer",
    baseURL: `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1`,
    apiKey,
    headers,
  };
}

/** The part of a Vercel `providerOptions` bag this shim reads. */
export interface VercelProviderOptions {
  gateway?: {
    order?: string[];
    /** Becomes a client-side chain, opt-in. */
    models?: string[];
    only?: string[];
    [extra: string]: unknown;
  };
  [provider: string]: unknown;
}

/** Every documented `providerOptions.gateway` key is converted or refused, never dropped. */
const GATEWAY_REFUSALS: Record<string, string> = {
  order:
    "provider pinning has no Conifer equivalent: the gateway picks the host for the admitted model by price and health, and the model you named is always the model you are charged for. Use `maxCostNanoUsd` if the goal was cost control.",
  only:
    "restricting which providers may serve a model has no Conifer equivalent — the gateway admits the model, then chooses the host itself. Use `maxCostNanoUsd` if the goal was cost control.",
  ignore:
    "excluding specific providers has no Conifer equivalent: host selection is the gateway's, and it is not overridable per request.",
  sort:
    "Conifer does not expose a provider sort order. The gateway already selects by price and health for the model you named; there is no second ranking to override.",
  allowFallbacks:
    "server-side provider fallback has no Conifer equivalent — the gateway admits exactly the model you name. Use `fallbackModels` with `allowClientFallback: true` for an explicit CLIENT-side chain of separately billed turns.",
  requireParameters:
    "Conifer does not filter hosts by which sampling parameters they implement. Send the parameters you need; an upstream that ignores one is the upstream's behavior, and the SDK will not pretend otherwise.",
  require_parameters:
    "Conifer does not filter hosts by which sampling parameters they implement. Send the parameters you need; an upstream that ignores one is the upstream's behavior, and the SDK will not pretend otherwise.",
  quantizations:
    "Conifer does not let a caller select a host by weight quantization. The catalog entry you name is the one served.",
  maxPrice:
    "a per-token price ceiling has no direct equivalent, and silently approximating one would be worse than refusing. Use `maxCostNanoUsd`, which is a HARD ceiling on the whole turn's worst case and is enforced by the gateway before any upstream call.",
  // Retention constraints are promises the caller made to their own users.
  dataCollection:
    "Conifer has no per-request data-collection toggle, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
  zdr:
    "zero-data-retention is not a per-request flag on Conifer, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
};

/**
 * `providerOptions` to the Conifer request fields it implies. Keys for other
 * providers are returned as `passthrough` for you to place in `extraBody`.
 */
export function fromVercelProviderOptions(
  providerOptions: VercelProviderOptions,
  options: { allowClientFallback?: boolean } = {},
): { request: Partial<ChatRequest>; passthrough: Record<string, unknown> } {
  const gateway = providerOptions.gateway ?? {};
  for (const [key, why] of Object.entries(GATEWAY_REFUSALS)) {
    if (gateway[key] !== undefined) {
      throw new ConiferPortabilityError(`providerOptions.gateway.${key}`, why);
    }
  }
  const request: Partial<ChatRequest> = {};
  if (gateway.models !== undefined) {
    request.fallbackModels = gateway.models;
    request.allowClientFallback = options.allowClientFallback;
  }
  // An unknown gateway key may be a constraint, so it is refused, not ignored.
  const unknown = Object.keys(gateway).filter(
    (key) => key !== "models" && gateway[key] !== undefined,
  );
  if (unknown.length > 0) {
    throw new ConiferPortabilityError(
      `providerOptions.gateway.${unknown[0]}`,
      `\`${unknown.join("`, `")}\` ${unknown.length === 1 ? "is a" : "are"} Vercel gateway control${unknown.length === 1 ? "" : "s"} this shim does not recognize. It is refused rather than ignored, because a routing or privacy constraint that vanishes in migration is the one failure this shim exists to prevent. Remove it, or open an issue if Conifer should honor it.`,
    );
  }
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerOptions)) {
    if (key !== "gateway") passthrough[key] = value;
  }
  return { request, passthrough };
}

/** Refuse a surface this gateway does not serve at the call site, instead of a 404 in production. */
export function assertSupportedVercelSurface(surface: string): void {
  const unsupported: Record<string, string> = {
    "image-generation":
      "Conifer serves no image-output door. Keep image generation on your current provider.",
    oidc:
      "there is no Conifer OIDC exchange. Mint a key at https://conifer.build/console#/keys and set CONIFER_API_KEY.",
    rerank:
      "Conifer does not serve reranking. The embedding models on this gateway (GET /v1/models, caps includes \"embeddings\") can rank by cosine similarity, or keep reranking on your current provider.",
    moderations:
      "Conifer serves no moderation door, and never silently applies one either — what you send is what runs. Keep moderation on your current provider.",
    audio:
      "Conifer serves no audio door (neither speech nor transcription). Keep audio on your current provider.",
    files:
      "Conifer serves no Files API. There is no server-side document store to upload to; send content in the request itself.",
    batches:
      "Conifer serves no Batches API. The nearest equivalent is a deferred job: `conifer.defer({...})` submits the turn against a >=24h window and `conifer.jobs.wait(jobId)` collects it.",
  };
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
    CONIFER_API_KEY: "sk-conifer-…",
    OPENAI_BASE_URL: `${DEFAULT_BASE_URL}/v1`,
    OPENAI_API_KEY: "$CONIFER_API_KEY",
  };
}
