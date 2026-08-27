// portability/openrouter.ts — take an OpenRouter request, get a Conifer one.
//
// The whole design decision is in cards/portability.card.json: a field Conifer
// cannot honor THROWS. OpenRouter's `provider` block pins a serving host, its
// `plugins` inject server-side behavior, and its `transforms` rewrite the
// prompt. Dropping any of them silently would leave a migrated app running a
// materially different request and quietly costing something else. So the shim
// refuses, names the field, and says what to use instead.

import { ConiferPortabilityError } from "../errors.ts";
import type { ChatRequest, Message } from "../types.ts";

/** The subset of OpenRouter's request type this shim reads. */
export interface OpenRouterRequest {
  model?: string;
  messages?: Message[];
  prompt?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  reasoning?: Record<string, unknown>;
  /** OpenRouter's fallback list. Becomes a CLIENT-SIDE chain here. */
  models?: string[];
  route?: string;
  provider?: unknown;
  plugins?: unknown[];
  transforms?: string[];
  user?: string;
  top_k?: number;
  min_p?: number;
  top_a?: number;
  repetition_penalty?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  [extra: string]: unknown;
}

export interface ShimOptions {
  /** Accept that `models` becomes N separate billed requests. */
  allowClientFallback?: boolean;
  /**
   * Forward sampling knobs Conifer does not model (`top_k`, `min_p`, …) into
   * the body anyway. Off by default: an unmodelled knob may be ignored by the
   * upstream, and pretending otherwise is the thing this file exists to avoid.
   */
  passthroughUnknown?: boolean;
}

const REFUSALS: Record<string, string> = {
  provider:
    "OpenRouter's `provider` preferences pin a serving host. Conifer picks the host for the admitted model itself, by price and health, and no client can override it. Remove the block, or use `maxCostNanoUsd` if the goal was cost control.",
  route:
    "`route: \"fallback\"` is server-side failover. Conifer admits exactly the model you name; use `models` with `allowClientFallback: true` for an explicit client-side chain.",
  plugins:
    "OpenRouter plugins (web, file-parser, response-healing, context-compression) run inside their gateway. Conifer has no equivalent, so this request would silently lose that behavior.",
  transforms:
    "`transforms` (middle-out) rewrites your prompt server-side. Conifer refuses an over-window request with a typed 400 naming the window instead. Trim the prompt yourself, or pick a model with a larger context window.",
  prompt:
    "`prompt` is the legacy text-completion field. The gateway DOES serve it at POST /v1/completions (billed and receipted like any other turn), but this shim converts to the chat wire and this SDK client does not drive that door — and note /v1/completions is non-streaming, so `stream: true` there is refused. Send `messages` instead, or call /v1/completions directly with your existing OpenAI-compatible client.",
};

/**
 * OpenRouter fields Conifer's request card does not model.
 *
 * These are NOT refusals: the gateway forwards unknown body fields rather than
 * rejecting them (verified live 2026-08-27 — `seed`, `frequency_penalty`,
 * `presence_penalty`, `top_logprobs`, `user`, `prediction` and even an invented
 * field all return 200). Whether the UPSTREAM honors any of them is the
 * provider's business and varies by model, which is exactly why the SDK will
 * not quietly pass them along as though they were guaranteed.
 *
 * So they throw by default and are forwarded under `passthroughUnknown: true`.
 * That is the whole point: the caller learns the knob is unmodelled at the call
 * site, and opts in with their eyes open.
 *
 * KEEPING THIS LIST HONEST IS THE JOB. A field that is neither refused nor
 * listed here is SILENTLY DROPPED, which violates the first law on the
 * portability card ("never silently drop a constraint"). Six fields were being
 * dropped exactly that way until this list was checked against OpenRouter's
 * current published request schema rather than against our own card:
 * `frequency_penalty`, `presence_penalty`, `top_logprobs`, `prediction`,
 * `debug`, and (differently) `user`. `tests/portability.test.ts` now drives
 * this from the vendor's field list so the next divergence fails the build.
 */
const UNMODELLED = [
  "top_k",
  "min_p",
  "top_a",
  "repetition_penalty",
  "logit_bias",
  "seed",
  // Added 2026-08-27, from OpenRouter's current schema. Each was previously
  // accepted and then dropped without a word.
  "frequency_penalty",
  "presence_penalty",
  "top_logprobs",
  "prediction",
  "debug",
] as const;

/**
 * OpenRouter request -> Conifer request.
 *
 * Model ids need no rewriting: the gateway resolves `vendor/model` by trying
 * the full id first and the last segment second, so `anthropic/claude-opus-5`
 * lands on the catalog's `claude-opus-5` without the client guessing.
 */
export function fromOpenRouter(
  request: OpenRouterRequest,
  options: ShimOptions = {},
): ChatRequest {
  for (const [field, why] of Object.entries(REFUSALS)) {
    if (request[field] !== undefined) throw new ConiferPortabilityError(field, why);
  }
  if (request.model === undefined) {
    throw new ConiferPortabilityError(
      "model",
      "OpenRouter falls back to an account default model when `model` is omitted. Conifer has no account default: name the model.",
    );
  }
  if (request.messages === undefined) {
    throw new ConiferPortabilityError("messages", "`messages` is required.");
  }

  const extraBody: Record<string, unknown> = {};
  for (const knob of UNMODELLED) {
    if (request[knob] === undefined) continue;
    if (options.passthroughUnknown !== true) {
      throw new ConiferPortabilityError(
        knob,
        `\`${knob}\` is not part of Conifer's request card; the upstream may ignore it. Pass \`passthroughUnknown: true\` to forward it anyway, at your own risk.`,
      );
    }
    extraBody[knob] = request[knob];
  }

  const converted: ChatRequest = {
    model: request.model,
    messages: request.messages,
    maxTokens: request.max_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    stop: request.stop,
    tools: request.tools,
    toolChoice: request.tool_choice,
    responseFormat: request.response_format,
    reasoning: request.reasoning,
    // `user` is OpenRouter's abuse-detection identifier; the nearest honest
    // Conifer equivalent is caller attribution, which is what it becomes.
    client: request.user,
    fallbackModels: request.models,
    allowClientFallback: options.allowClientFallback,
    extraBody: Object.keys(extraBody).length === 0 ? undefined : extraBody,
  };
  return stripUndefined(converted);
}

/**
 * OpenRouter's app-attribution headers -> Conifer's.
 *
 * `HTTP-Referer` and `X-Title` exist to rank your app on OpenRouter's public
 * board. Conifer has no such board, so they become usage attribution only.
 */
export function attributionFromOpenRouter(headers: Record<string, string>): string | undefined {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  // `X-OpenRouter-Categories` assigns MARKETPLACE categories on openrouter.ai.
  // Conifer runs no marketplace and no public leaderboard, so there is nothing
  // for it to become. Refusing beats returning it as an app name — which is
  // what a lenient reading would do, mislabelling every turn's attribution.
  if (lower["x-openrouter-categories"] !== undefined) {
    throw new ConiferPortabilityError(
      "X-OpenRouter-Categories",
      "this header assigns categories in OpenRouter's public model marketplace. Conifer has no marketplace or leaderboard to list your app on, so there is no equivalent. Drop it; `x-conifer-client` carries the app NAME for your own usage attribution.",
    );
  }
  return lower["x-openrouter-title"] ?? lower["x-title"] ?? lower["http-referer"];
}

/** Drop explicit `undefined` keys so a converted request serializes cleanly. */
function stripUndefined(request: ChatRequest): ChatRequest {
  const bag = request as unknown as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (bag[key] === undefined) delete bag[key];
  }
  return request;
}
