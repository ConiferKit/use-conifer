// Public request and response shapes. Every field maps to a real gateway
// input or output; fields the gateway forwards opaquely are typed opaquely.

import type { Receipt } from "./receipt.ts";

// -------------------------------------------------------------------- chat

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  [extra: string]: unknown;
}

export interface FallbackOptions {
  /**
   * Client-side chain: models to try in order, each as a separate billed
   * request, when the primary fails retryably. Requires `allowClientFallback`.
   */
  fallbackModels?: string[];
  allowClientFallback?: boolean;
  /**
   * Server-side chain: models the gateway falls back to inside one request
   * when the requested model's upstream call fails. One hold, one bill, and
   * a served fallback is disclosed in `receipt.effectiveModel` with
   * `receipt.reason === "provider_failover"`. At most three. Not available
   * with `defer`.
   */
  serverFallbackModels?: string[];
}

export interface ChatRequest extends FallbackOptions {
  /** A catalog id, or `auto` / `balanced` / `best` to let the router pick. */
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: unknown[];
  toolChoice?: unknown;
  /** Forwarded verbatim. */
  responseFormat?: unknown;
  /** Forwarded as the gateway's `reasoning` block. */
  reasoning?: { effort?: "none" | "low" | "medium" | "high" } & Record<string, unknown>;

  /** Hard ceiling on this call's cost, in integer nanodollars. Over it, the call is refused. */
  maxCostNanoUsd?: number;
  /** Advisory completion window in whole seconds. */
  deadlineSeconds?: number;
  /** Submit as a deferred job. Use `defer()`, which returns the job. */
  defer?: boolean;
  /** Hard venue constraint. The hosted gateway is `cloud`. */
  venue?: "cloud" | "any" | "local";
  /** `"off"` skips prompt-cache annotation for this turn. */
  promptCache?: "off";

  idempotencyKey?: string;
  requestId?: string;
  /** Your app's name, for your own usage attribution. */
  client?: string;
  headers?: Record<string, string>;
  /** Fields the SDK does not model, merged into the body. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    [extra: string]: unknown;
  };
  completion_tokens_details?: { reasoning_tokens?: number; [extra: string]: unknown };
  /** Settled cost in decimal USD, copied from the receipt. Absent on a stream. */
  cost?: number;
  /** The same cost as integer nanodollars. */
  cost_nanousd?: number;
  [extra: string]: unknown;
}

export interface Choice {
  index?: number;
  finish_reason?: string | null;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: unknown[];
    /** Vendor reasoning trace, when the model emits one. */
    reasoning?: string;
    /** DeepSeek's name for the same field. */
    reasoning_content?: string;
    [extra: string]: unknown;
  };
  delta?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface Completion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Choice[];
  usage?: Usage;
  /** The `x-conifer-*` headers, parsed. */
  receipt: Receipt;
  /** Which chain member served. 0 is the model you asked for. */
  fallbackIndex: number;
  [extra: string]: unknown;
}

/** The first choice's text content, or `undefined`. */
export function textOf(completion: Completion): string | undefined {
  const content = completion.choices[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Why a completion has no text, as a sentence, or `undefined` when it has
 * text or a tool call. The common cause is a reasoning model spending
 * `maxTokens` on its thinking block before the visible answer.
 */
export function emptyReason(completion: Completion): string | undefined {
  const choice = completion.choices[0];
  if (choice === undefined) {
    return "the gateway returned no choices at all. If this was a deferred turn, use `defer()` and `jobs.wait()`; a 202 job envelope is not a completion.";
  }
  const content = choice.message?.content;
  if (typeof content === "string" && content !== "") return undefined;
  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) return undefined;
  if (choice.finish_reason === "length") {
    const reasoning = completion.usage?.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoning === "number" && reasoning > 0) {
      return `the model hit maxTokens while still reasoning (${reasoning} of ${completion.usage?.completion_tokens} output tokens went to thinking), so it never reached the visible answer. Raise maxTokens, or lower reasoning.effort on a model that supports it.`;
    }
    return "the model hit maxTokens before emitting visible text. On a reasoning model the thinking block is spent FIRST, so a small maxTokens can be used up before the answer starts. Raise maxTokens.";
  }
  if (choice.finish_reason === "content_filter") {
    return "the upstream provider's own content filter stopped this turn. Conifer applies no moderation of its own.";
  }
  return `the model returned empty content with finish_reason ${JSON.stringify(choice.finish_reason)}.`;
}

// --------------------------------------------------------------- streaming

export interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Choice[];
  usage?: Usage;
  [extra: string]: unknown;
}

/**
 * A streamed turn: an async iterable of chunks plus its receipt. Async
 * iteration lives in `lib.es2018`, so a consumer targeting ES2017 or older
 * sees TS2583 pointing here. Target ES2018+ or add `"lib": ["ES2018"]`.
 */
export interface CompletionStream extends AsyncIterable<StreamChunk> {
  /**
   * The routing receipt, read from the response head before the first chunk.
   * Cost fields are absent on a stream; reconcile from the final `usage` chunk.
   */
  receipt(): Promise<Receipt>;
  /** Stop now: the gateway stops generating and billing. Safe in any state. */
  cancel(): Promise<void>;
  fallbackIndex: number;
}

// ----------------------------------------------------------------- catalog

export interface Pricing {
  [class_: string]: unknown;
}

export interface CatalogModel {
  id: string;
  /** `"conifer"` (credits) or `"byok"` (your own key serves it). */
  endpointKind?: string;
  displayName?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Declared minimum completion budget, including reasoning tokens. */
  minOutputTokens?: number;
  /** False means completions are refused before spend. Absent means undeclared. */
  outputTokenLimitSupported?: boolean;
  maxTools?: number;
  /** Declared capabilities. Absent means undeclared, not unsupported. */
  caps?: string[];
  /** Native vector width of an embedding model. `dimensions` on a request overrides it. */
  embeddingDimensions?: number;
  /** The as-charged price for this entry's lane. */
  pricing?: Pricing;
  /** BYOK take rate as a percent. */
  feePct?: number;
  /** True when BYOK custody is degraded for a provider you hold a key for. */
  unavailable?: boolean;
  raw: Record<string, unknown>;
}

export interface Balance {
  remainingNanoUsd: number;
  includedNanoUsd?: number;
  allowanceRemainingNanoUsd?: number;
  creditsRemainingNanoUsd?: number;
  remainingUsd: string;
}

// ----------------------------------------------------------------- routing

/**
 * The routing policies the gateway serves. They double as model ids:
 * `chat({ model: "auto" })` runs `balanced`. `cost-effective` and `fast`
 * exist in the router but are muted on the gateway; the virtual rows of
 * `models()` are the authority for what a given gateway serves.
 */
export type RoutePolicy = "balanced" | "best" | (string & {});

export interface RouteRequest {
  /** The current ask: the last user message. */
  query: string;
  /** Defaults to `balanced`. */
  policy?: RoutePolicy;
  /** Restrict the field to these catalog ids. Intersected with your own listing. */
  candidates?: string[];
  /** The turn will carry tool schemas. */
  tools?: boolean;
  /** The completion cap the turn will run under. */
  maxOutputTokens?: number;
}

/** The router's decision: a pick and fallbacks, never a score. */
export interface RouteDecision {
  /** A catalog id you can call. */
  model: string;
  /** The router's next picks, in order. At most three. */
  fallbacks: string[];
  policy: RoutePolicy;
  /** The router artifact that produced this decision. */
  routerVersion: string;
  raw: Record<string, unknown>;
}

// -------------------------------------------------------------- embeddings

/** One embeddings call. Billed on input only, so there are no sampling fields. */
export interface EmbeddingsRequest {
  /** A model whose `caps` include `embeddings`. */
  model: string;
  /** Text or a batch of texts. Token-id arrays are refused. */
  input: string | string[];
  /** Matryoshka shortening, where the model supports it. */
  dimensions?: number;
  /** Wire encoding. Defaults to `base64`, which the SDK decodes to numbers. */
  encodingFormat?: "float" | "base64";
  /** Opaque end-user id, forwarded verbatim. */
  user?: string;

  /** Hard ceiling on this call's cost, in integer nanodollars. */
  maxCostNanoUsd?: number;
  idempotencyKey?: string;
  requestId?: string;
  /** Your app's name, for your own usage attribution. */
  client?: string;
  headers?: Record<string, string>;
  /** Fields the SDK does not model, merged into the body. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Embedding {
  index: number;
  /** The vector as numbers, whatever the wire encoding was. */
  embedding: number[];
  object?: string;
  [extra: string]: unknown;
}

export interface EmbeddingsResponse {
  object?: string;
  model?: string;
  data: Embedding[];
  /** Input tokens only. */
  usage?: Usage;
  /** The `x-conifer-*` headers, parsed. */
  receipt: Receipt;
  /** The provider's own body, untouched. */
  raw: Record<string, unknown>;
}

/** The first vector, for the single-input call. */
export function vectorOf(response: EmbeddingsResponse): number[] | undefined {
  return response.data[0]?.embedding;
}

// ----------------------------------------------------------- deferred jobs

/**
 * A deferred job's lifecycle. `ended` and `fetched` were charged and have a
 * result; `expired`, `cancelled` and `failed` refund the unfinished work.
 */
export type JobStatus =
  | "queued"
  | "submitted"
  | "ended"
  | "fetched"
  | "expired"
  | "cancelled"
  | "failed";

/** States a job never leaves. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["fetched", "expired", "cancelled", "failed"];

export function isTerminalJob(status: JobStatus | string | undefined): boolean {
  return TERMINAL_JOB_STATUSES.includes(status as JobStatus);
}

/** A deferred job as returned by the 202 accept and every status poll. No content, no cost. */
export interface DeferredJob {
  jobId: string;
  status: JobStatus | string;
  /** Unix seconds. After this the job expires. */
  deadlineUtc?: number;
  createdUtc?: number;
  model?: string;
  /** The gateway's poll path, relative to the base URL. */
  pollUrl?: string;
  raw: Record<string, unknown>;
}
