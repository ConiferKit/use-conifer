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
    "the legacy text-completion `prompt` field has no Conifer door. Send `messages` instead.",
};

const UNMODELLED = [
  "top_k",
  "min_p",
  "top_a",
  "repetition_penalty",
  "logit_bias",
  "seed",
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
