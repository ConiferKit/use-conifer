// The wire shape of one chat turn: body, headers, the model chain, and the
// idempotency key that ties retries together.

import { ConiferPortabilityError } from "./errors.ts";
import type { ChatRequest, Completion } from "./types.ts";

/** The gateway accepts at most this many server-side fallback models. */
export const MAX_SERVER_FALLBACK_MODELS = 3;

/** The JSON body for `POST /v1/chat/completions`. */
export function chatBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  if (request.tools !== undefined) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.responseFormat !== undefined) body.response_format = request.responseFormat;
  if (request.reasoning !== undefined) body.reasoning = request.reasoning;
  if (request.deadlineSeconds !== undefined) body.completion_window_seconds = request.deadlineSeconds;
  if (request.defer === true) body.defer = "allow";
  if (stream) {
    body.stream = true;
    // The final usage chunk is what lets a streamed turn be reconciled.
    body.stream_options = { include_usage: true };
  }
  return { ...body, ...(request.extraBody ?? {}) };
}

/** The request headers for one chat turn. Throws on values the wire cannot carry. */
export function chatHeaders(request: ChatRequest, idempotencyKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    "idempotency-key": idempotencyKey,
  };
  if (request.maxCostNanoUsd !== undefined) {
    headers["x-conifer-max-cost-nanousd"] = costCeiling(request.maxCostNanoUsd);
  }
  if (request.deadlineSeconds !== undefined) headers["x-conifer-deadline"] = String(request.deadlineSeconds);
  if (request.defer === true) headers["x-conifer-defer"] = "allow";
  if (request.venue !== undefined) headers["x-conifer-venue"] = request.venue;
  if (request.promptCache === "off") headers["x-conifer-cache"] = "off";
  if (request.serverFallbackModels !== undefined) {
    const chain = serverFallbackHeader(request.serverFallbackModels, request.model);
    if (chain !== undefined) headers["x-conifer-fallback-models"] = chain;
  }
  if (request.requestId !== undefined) headers["x-request-id"] = request.requestId;
  if (request.client !== undefined) headers["x-conifer-client"] = request.client;
  return headers;
}

/** A spend ceiling is an integer number of nanodollars. Fractions are refused, not rounded. */
export function costCeiling(nanoUsd: number): string {
  if (!Number.isInteger(nanoUsd)) {
    throw new ConiferPortabilityError(
      "maxCostNanoUsd",
      "the cost ceiling is an integer nanodollar amount ($1 = 1e9). A fractional value is refused rather than rounded.",
    );
  }
  return String(nanoUsd);
}

/**
 * The `x-conifer-fallback-models` header value, validated the way the gateway
 * validates it: blank, comma-bearing or non-ASCII members throw; duplicates
 * and the primary model are dropped; at most three survive. Returns
 * `undefined` when nothing survives so the caller omits the header.
 */
export function serverFallbackHeader(models: string[], primary: string): string | undefined {
  const trimmed = models.map((m) => m.trim());
  if (trimmed.some((m) => m === "")) {
    throw new ConiferPortabilityError(
      "serverFallbackModels",
      "a fallback member is empty. Drop it, or drop the field if you do not want fallbacks.",
    );
  }
  const unsendable = trimmed.find((m) => m.includes(",") || /[^\x20-\x7e]/.test(m));
  if (unsendable !== undefined) {
    throw new ConiferPortabilityError(
      "serverFallbackModels",
      `\`${unsendable}\` cannot ride a comma-separated ASCII header.`,
    );
  }
  const chain: string[] = [];
  for (const model of trimmed) {
    if (model === primary.trim() || chain.includes(model)) continue;
    chain.push(model);
  }
  if (chain.length > MAX_SERVER_FALLBACK_MODELS) {
    throw new ConiferPortabilityError(
      "serverFallbackModels",
      `at most ${MAX_SERVER_FALLBACK_MODELS} fallback models are accepted per request.`,
    );
  }
  return chain.length === 0 ? undefined : chain.join(",");
}

/**
 * The models `chat()` will try, in order. A client-side chain is a sequence of
 * separately billed requests, so it has to be opted into.
 */
export function resolveChain(request: ChatRequest): string[] {
  const fallbacks = request.fallbackModels ?? [];
  if (fallbacks.length === 0) return [request.model];
  if (request.allowClientFallback !== true) {
    throw new ConiferPortabilityError(
      "fallbackModels",
      "fallbackModels is a client-side chain of separate billed requests. Pass `allowClientFallback: true` to accept that, or use serverFallbackModels for one request.",
    );
  }
  return [request.model, ...fallbacks];
}

/**
 * The idempotency key for one logical turn. The gateway derives its request id
 * from this header, so an explicit `requestId` becomes the key: the id you
 * chose is the id that comes back. Pass `idempotencyKey` to control the two
 * separately.
 */
export function turnIdentity(request: { idempotencyKey?: string; requestId?: string }): string {
  return request.idempotencyKey ?? request.requestId ?? randomId("idem");
}

/**
 * Copy the settled cost from the receipt headers onto `usage`, where
 * OpenRouter-shaped code and most logging pipelines look for it. Additive
 * only: a server-provided `usage.cost` wins, and an absent cost stays absent.
 */
export function withCost(
  usage: Completion["usage"],
  receipt: { costNanoUsd?: number },
): Completion["usage"] {
  if (receipt.costNanoUsd === undefined) return usage;
  const existing = usage ?? {};
  if (existing.cost !== undefined) return usage;
  return {
    ...existing,
    cost: receipt.costNanoUsd / 1_000_000_000,
    cost_nanousd: receipt.costNanoUsd,
  };
}

/** A completion from a response body and its receipt. */
export function toCompletion(data: unknown, receipt: Completion["receipt"], fallbackIndex: number): Completion {
  const payload = (data ?? {}) as Record<string, unknown>;
  return {
    ...payload,
    choices: (payload.choices as Completion["choices"]) ?? [],
    usage: withCost(payload.usage as Completion["usage"], receipt),
    receipt,
    fallbackIndex,
  } as Completion;
}

export function randomId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${uuid}`;
}
