// Helicone's header protocol, mapped to Conifer request fields or refused.
// Helicone is a proxy in front of your own provider key; Conifer is the
// destination and the biller. Headers for controls Conifer does not have
// (moderation, prompt registry, retention switches) throw rather than no-op.

import { ConiferPortabilityError } from "../errors.ts";
import type { ChatRequest } from "../types.ts";

export interface HeliconeHeaders {
  [name: string]: string | undefined;
}

const REFUSALS: Record<string, string> = {
  "helicone-target-url":
    "Conifer is the destination, not a pass-through proxy. Drop this header and point your base URL at https://api.conifer.build/v1.",
  "helicone-openai-api-base":
    "same as Helicone-Target-URL. For Azure, register the resource once as BYOK custody (`client.keys.put(\"azure\", key, url)`) and keep calling Conifer.",
  "helicone-prompt-id":
    "Conifer has no server-side prompt registry or versioning. Version prompts in your own repo.",
  "helicone-moderations-enabled":
    "Conifer runs no moderation layer. Refusing loudly rather than silently passing an unmoderated request through.",
  "helicone-llm-security-enabled":
    "Conifer runs no prompt-injection scanner. Refusing loudly rather than silently dropping a security control.",
  "helicone-token-limit-exception-handler":
    "Conifer never truncates or middle-outs your prompt. An over-window request gets a typed 400 naming the model's window, so you decide what to cut.",
  "helicone-session-id":
    "Conifer's observability has no session tree. Correlate with your own ids via `x-request-id`.",
  "helicone-session-path": "see Helicone-Session-Id.",
  "helicone-session-name": "see Helicone-Session-Id.",
  "helicone-posthog-key": "Conifer does not fan out to third-party analytics.",
  "helicone-posthog-host": "see Helicone-Posthog-Key.",
  // Retention switches are promises the caller made to their own users.
  "helicone-omit-request":
    "Conifer has no per-request switch to omit the prompt from what it retains, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
  "helicone-omit-response":
    "Conifer has no per-request switch to omit the completion from what it retains, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
  "helicone-auth":
    "this is your HELICONE credential, and it means the request was going through Helicone as a proxy. Conifer is the destination: drop it and authenticate with CONIFER_API_KEY.",
  "helicone-retry-enabled":
    "Helicone retries server-side, on its own policy. This SDK retries in the CLIENT, narrowly (transport faults and 409/429/502/503/504), and every retry reuses one idempotency key so it cannot double-bill. Set `maxRetries` for a different budget.",
};

/** Headers that are converted below or deliberately inert, so the catch-all can tell them from unknown ones. */
const INERT = new Set(["helicone-property-", "helicone-cache-enabled", "helicone-request-id", "helicone-user-id", "helicone-fallbacks", "helicone-ratelimit-policy"]);

/**
 * A Helicone header bag to the Conifer request fields it implies. Returns a
 * partial request to merge into your call, plus the `Helicone-Property-*`
 * values, which Conifer does not store.
 */
export function fromHeliconeHeaders(headers: HeliconeHeaders): {
  request: Partial<ChatRequest>;
  properties: Record<string, string>;
} {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) lower[key.toLowerCase()] = value;
  }

  for (const [name, why] of Object.entries(REFUSALS)) {
    if (lower[name] !== undefined) throw new ConiferPortabilityError(name, why);
  }

  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(lower)) {
    if (key.startsWith("helicone-property-")) {
      properties[key.slice("helicone-property-".length)] = value;
    }
  }

  const request: Partial<ChatRequest> = {};
  if (lower["helicone-request-id"] !== undefined) {
    request.requestId = lower["helicone-request-id"];
  }
  const attribution = lower["helicone-user-id"];
  if (attribution !== undefined) request.client = attribution;

  // The cache header can only turn caching off.
  const cache = lower["helicone-cache-enabled"];
  if (cache === "false") request.promptCache = "off";
  if (cache === "true") {
    throw new ConiferPortabilityError(
      "helicone-cache-enabled",
      "Conifer decides when to prompt-cache; a client cannot force a cache-WRITE class it would then be charged for. `false` maps to the real opt-out (`x-conifer-cache: off`); `true` has no equivalent.",
    );
  }

  const fallbacks = lower["helicone-fallbacks"];
  if (fallbacks !== undefined) {
    // The gateway-side chain: the proxy walked it on one request, and so does Conifer.
    request.serverFallbackModels = parseFallbacks(fallbacks);
  }

  const policy = lower["helicone-ratelimit-policy"];
  if (policy !== undefined) request.maxCostNanoUsd = ceilingFromPolicy(policy);

  // An unknown Helicone header may carry a constraint, so it is refused, not ignored.
  const unknown = Object.keys(lower).filter(
    (key) =>
      key.startsWith("helicone-") &&
      !key.startsWith("helicone-property-") &&
      !INERT.has(key) &&
      REFUSALS[key] === undefined,
  );
  if (unknown.length > 0) {
    throw new ConiferPortabilityError(
      unknown[0] as string,
      `\`${unknown.join("`, `")}\` ${unknown.length === 1 ? "is a" : "are"} Helicone header${unknown.length === 1 ? "" : "s"} this shim does not recognize. It is refused rather than ignored, because an observability or privacy control that vanishes in migration is the one failure this shim exists to prevent. Remove it, or open an issue if Conifer should honor it.`,
    );
  }

  return { request, properties };
}

/** `Helicone-Fallbacks` is a JSON array; return the model ids in order. */
export function parseFallbacks(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConiferPortabilityError(
      "helicone-fallbacks",
      "Helicone-Fallbacks must be a JSON array; could not parse it.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConiferPortabilityError("helicone-fallbacks", "expected a JSON array.");
  }
  return parsed.map((entry) => {
    if (typeof entry === "string") return entry;
    const model = (entry as { model?: unknown })?.model;
    if (typeof model === "string") return model;
    throw new ConiferPortabilityError(
      "helicone-fallbacks",
      "each fallback entry must be a model id string or an object with a `model` field. Helicone entries that pin a target URL have no Conifer equivalent.",
    );
  });
}

/**
 * `[quota];w=[window];u=[unit];s=[segment]` to a nanodollar ceiling. Only a
 * `cents` quota converts, and it becomes a per-request ceiling, not a
 * window budget.
 */
export function ceilingFromPolicy(policy: string): number {
  const parts = policy.split(";").map((part) => part.trim());
  const quota = Number.parseInt(parts[0] ?? "", 10);
  const unit = parts.find((part) => part.startsWith("u="))?.slice(2);
  if (!Number.isFinite(quota)) {
    throw new ConiferPortabilityError(
      "helicone-ratelimit-policy",
      "could not read the quota from the policy string.",
    );
  }
  if (unit !== "cents") {
    throw new ConiferPortabilityError(
      "helicone-ratelimit-policy",
      `Conifer's per-request control is a money ceiling, so only \`u=cents\` maps. \`u=${unit ?? "requests"}\` has no equivalent: use your own limiter for request counts.`,
    );
  }
  return quota * 10_000_000;
}
