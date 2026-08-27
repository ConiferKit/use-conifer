// portability/helicone.ts — Helicone's header protocol, mapped or refused.
//
// Helicone is a header-driven proxy that sits in front of YOUR provider key.
// Conifer is the biller and the router itself. That shape difference decides
// every mapping here:
//
//   · `Helicone-Auth` + your provider key  ->  one `CONIFER_API_KEY`. If you
//     want your own provider key used, that is BYOK custody (`client.keys.put`),
//     not a second header.
//   · `Helicone-Target-URL` -> nothing. Conifer IS the destination. A migrated
//     app that still believes it is proxying elsewhere is a bug, so this throws.
//   · Safety features (moderation, LLM security, token-limit handlers) throw
//     rather than no-op: a security control that silently does nothing is worse
//     than an error, because the error is visible.

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
  // PRIVACY. Dropping either is the worst case in this file: the request
  // succeeds, nothing errors, and a promise the caller made to THEIR OWN users
  // — that prompts or completions are not retained — has quietly lapsed.
  "helicone-omit-request":
    "Conifer has no per-request switch to omit the prompt from what it retains, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
  "helicone-omit-response":
    "Conifer has no per-request switch to omit the completion from what it retains, so this cannot be honored and MUST NOT be dropped — it is a promise you may have made to your own users. See https://conifer.build/privacy for what the gateway retains, and decide with that in hand.",
  "helicone-auth":
    "this is your HELICONE credential, and it means the request was going through Helicone as a proxy. Conifer is the destination: drop it and authenticate with CONIFER_API_KEY.",
  "helicone-retry-enabled":
    "Helicone retries server-side, on its own policy. This SDK retries in the CLIENT, narrowly (transport faults and 409/429/502/503/504), and every retry reuses one idempotency key so it cannot double-bill. Set `maxRetries` if you want a different budget \u2014 but a server-side retry you cannot see is not something Conifer will imitate.",
};

/**
 * Helicone headers that are OBSERVED rather than converted: they change what
 * Helicone recorded, not what the model did, so there is nothing to refuse and
 * nothing to send. Listed so the catch-all below can tell "deliberately inert"
 * from "we have never heard of this".
 */
const INERT = new Set(["helicone-property-", "helicone-cache-enabled", "helicone-request-id", "helicone-user-id", "helicone-fallbacks", "helicone-ratelimit-policy"]);

/**
 * A Helicone header bag -> the Conifer request fields it implies.
 *
 * Returns a PARTIAL request you merge into your own call, plus the custom
 * properties Helicone would have indexed server-side — handed back to you
 * because Conifer stores no arbitrary property index and will not pretend to.
 */
export function fromHeliconeHeaders(headers: HeliconeHeaders): {
  request: Partial<ChatRequest>;
  /** `Helicone-Property-*` values. Yours to log; Conifer does not store them. */
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

  // The cache header is asymmetric on purpose (see the gateway's own note):
  // it can only turn caching OFF.
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
    request.fallbackModels = parseFallbacks(fallbacks);
    // Deliberately NOT auto-enabling `allowClientFallback`: the caller has to
    // accept that each member is a separate billed request.
  }

  const policy = lower["helicone-ratelimit-policy"];
  if (policy !== undefined) request.maxCostNanoUsd = ceilingFromPolicy(policy);

  // Anything left is a Helicone header we have never heard of. NOT safe to
  // ignore: an unknown header is exactly the case where we cannot judge
  // whether it carried a constraint, and this shim exists so that a constraint
  // cannot go missing in transit. (Two of the headers above are privacy
  // promises that were being dropped here until 2026-08-27.)
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

/** `Helicone-Fallbacks` is a JSON dump; we want the model ids, in order. */
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
 * `[quota];w=[window];u=[unit];s=[segment]` -> a nanodollar ceiling.
 *
 * Only a `cents` quota converts: Conifer's control is a per-request MONEY
 * ceiling, which is strictly stronger than a request count but is not the same
 * quantity, so `u=requests` throws instead of being invented.
 *
 * Note the semantic narrowing, which is honest but real: Helicone's quota is a
 * budget over a WINDOW; `x-conifer-max-cost-nanousd` caps ONE request. The
 * mapped value is therefore a per-request ceiling of the whole window's budget
 * — an upper bound that no single call may exceed, not a running total.
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
  // 1 cent = 10^7 nanodollars.
  return quota * 10_000_000;
}
