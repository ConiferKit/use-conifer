// OpenRouter request to Conifer request. A field Conifer cannot honour throws
// with the field named, so a migration never silently changes what runs.

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
  /** OpenRouter's fallback list. With `route: "fallback"` it becomes the gateway-side chain. */
  models?: string[];
  /** Only `"fallback"` maps. */
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
  /** Accept that `models` becomes separate billed requests. */
  allowClientFallback?: boolean;
  /** Forward sampling knobs Conifer does not model. The upstream may ignore them. */
  passthroughUnknown?: boolean;
}

const REFUSALS: Record<string, string> = {
  provider:
    "OpenRouter's `provider` preferences pin a serving host. Conifer picks the host for the admitted model itself. Remove the block, or use `maxCostNanoUsd` if the goal was cost control.",
  plugins:
    "OpenRouter plugins (web, file-parser, response-healing, context-compression) run inside their gateway. Conifer has no equivalent, so this request would silently lose that behavior.",
  transforms:
    "`transforms` (middle-out) rewrites your prompt server-side. Conifer refuses an over-window request with a typed 400 instead. Trim the prompt, or pick a model with a larger context window.",
  prompt:
    "`prompt` is the legacy text-completion field. The gateway serves it at POST /v1/completions, but this shim converts to the chat wire. Send `messages`, or call /v1/completions directly.",
};

/**
 * Fields the gateway forwards but Conifer does not model. They throw unless
 * `passthroughUnknown` is set, so the caller learns the knob is unmodelled.
 * Kept in step with OpenRouter's published schema by tests/portability.test.ts.
 */
const UNMODELLED = [
  "top_k",
  "min_p",
  "top_a",
  "repetition_penalty",
  "logit_bias",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "top_logprobs",
  "prediction",
  "debug",
] as const;

/** Convert. Model ids need no rewriting: the gateway resolves `vendor/model` itself. */
export function fromOpenRouter(request: OpenRouterRequest, options: ShimOptions = {}): ChatRequest {
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
  if (request.route !== undefined) {
    if (request.route !== "fallback") {
      throw new ConiferPortabilityError(
        "route",
        `\`route: ${JSON.stringify(request.route)}\` is not a routing mode Conifer has. Only \`"fallback"\` maps, onto the gateway-side fallback chain.`,
      );
    }
    if (request.models === undefined || request.models.length === 0) {
      throw new ConiferPortabilityError(
        "route",
        '`route: "fallback"` asks for server-side failover but names nothing to fail over to. Send `models` with the substitutes you accept.',
      );
    }
  }

  const extraBody: Record<string, unknown> = {};
  for (const knob of UNMODELLED) {
    if (request[knob] === undefined) continue;
    if (options.passthroughUnknown !== true) {
      throw new ConiferPortabilityError(
        knob,
        `\`${knob}\` is not part of Conifer's request; the upstream may ignore it. Pass \`passthroughUnknown: true\` to forward it anyway.`,
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
    client: request.user,
    ...(request.route === "fallback"
      ? { serverFallbackModels: request.models }
      : { fallbackModels: request.models, allowClientFallback: options.allowClientFallback }),
    extraBody: Object.keys(extraBody).length === 0 ? undefined : extraBody,
  };
  return stripUndefined(converted);
}

/** OpenRouter's app-attribution headers become Conifer's `client` name. */
export function attributionFromOpenRouter(headers: Record<string, string>): string | undefined {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  if (lower["x-openrouter-categories"] !== undefined) {
    throw new ConiferPortabilityError(
      "X-OpenRouter-Categories",
      "this header assigns categories in OpenRouter's public marketplace. Conifer has no marketplace, so there is no equivalent. Drop it; `x-conifer-client` carries the app name for your own usage attribution.",
    );
  }
  return lower["x-openrouter-title"] ?? lower["x-title"] ?? lower["http-referer"];
}

function stripUndefined(request: ChatRequest): ChatRequest {
  const bag = request as unknown as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (bag[key] === undefined) delete bag[key];
  }
  return request;
}
