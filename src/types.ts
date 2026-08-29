// types.ts — the public shapes named by cards/sdk.input.card.json and
// cards/sdk.output.card.json. Nothing here is invented: every request field
// maps to a real gateway input, and every response field to a real gateway
// output. Fields the gateway forwards opaquely are typed opaquely on purpose.

import type { Receipt } from "./receipt.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  [extra: string]: unknown;
}

/** The client-side fallback posture. See cards/portability.card.json. */
export interface FallbackOptions {
  /**
   * Models to try, in order, if the primary fails RETRYABLY.
   *
   * This is a CLIENT-SIDE chain: the gateway admits exactly the model named,
   * so each member is a separate request. `allowClientFallback` must be true,
   * because a chain that silently spends on a second model is a surprise.
   */
  fallbackModels?: string[];
  allowClientFallback?: boolean;
  /**
   * Models the GATEWAY will fall back to, in order, if the requested model's
   * upstream call fails. Sent as `x-conifer-fallback-models`.
   *
   * Prefer this over `fallbackModels` for production traffic. The difference
   * is where the retry lives, and it matters:
   *
   * - `fallbackModels` is a CLIENT chain — a second HTTP request, decided
   *   here, only after a retryable refusal reaches you. It cannot help a
   *   streamed turn or a deferred job, and each member is separately billed.
   * - `serverFallbackModels` is ONE request. The gateway holds money once for
   *   the whole chain, dispatches the members in your order, settles ONCE
   *   against whichever served, and refunds in full if none did. Because the
   *   gateway sees the provider's own failure, it advances on classes the
   *   client never gets to judge — including the 4xx a mis-configured model
   *   surface returns, which is the failure this exists for.
   *
   * Every member is admitted like a primary BEFORE anything is spent: an
   * unknown model, a composed model, a duplicate, a self-reference, or more
   * than 3 members is refused by name rather than silently dropped — a
   * fallback you think is protecting you and is not is the one outcome worse
   * than an error.
   *
   * A served fallback is never silent: `completion.receipt.effectiveModel`
   * names the model that answered and `receipt.reason` reads
   * `provider_failover` (the gateway reuses that code rather than minting a
   * new one — the substitute is disclosed by `effectiveModel`). On a STREAMED
   * turn the handshake headers are written before the failover resolves, so
   * `reason` reads `as_requested` there while `effectiveModel` is still
   * correct — read the model, not the reason, to detect a substitution.
   *
   * Not available with `defer`, on the BYOK lane, or for composed models
   * (each refuses loudly).
   */
  serverFallbackModels?: string[];
}

export interface ChatRequest extends FallbackOptions {
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: unknown[];
  toolChoice?: unknown;
  /** Forwarded verbatim; honored where the upstream honors it. */
  responseFormat?: unknown;
  /** Forwarded as the gateway's `reasoning` block. Not every model emits a trace. */
  reasoning?: { effort?: "none" | "low" | "medium" | "high" } & Record<string, unknown>;

  /** HARD ceiling on the caller-total worst case. Over it, the request is refused. */
  maxCostNanoUsd?: number;
  /** ADVISORY completion window in whole seconds. Widens HOW, never WHAT or WHAT IT COSTS. */
  deadlineSeconds?: number;
  /** Opt into the 202 deferred-job protocol. Needs a wide window; refused loudly if unhonorable. */
  defer?: boolean;
  /** HARD venue constraint. This gateway is `cloud`; `local` is refused here. */
  venue?: "cloud" | "any" | "local";
  /** Only `"off"` is meaningful: skip prompt-cache annotation for this one turn. */
  promptCache?: "off";

  idempotencyKey?: string;
  requestId?: string;
  /** Your app's name, for your own usage attribution. */
  client?: string;
  headers?: Record<string, string>;
  /** Fields the SDK does not model, merged into the body at your own risk. */
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
  /**
   * The settled cost of this turn in decimal USD, copied onto the BODY from the
   * receipt headers. See `withCost`: OpenRouter puts cost here, and every
   * logging pipeline keeps bodies while discarding headers, so a migrating team
   * would otherwise lose their cost column without noticing.
   *
   * ABSENT on a stream, where the head carries no cost — a 0 would read as
   * "free". `receipt.costNanoUsd` remains the authority.
   */
  cost?: number;
  /** The same figure as the exact integer nanodollars the gateway billed. */
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
    /** Vendor reasoning trace. Absent is the ABSENCE signal, not a bug. */
    reasoning?: string;
    /** DeepSeek's name for the same thing. */
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
  /** The x-conifer-* disclosure, parsed. */
  receipt: Receipt;
  /** Which chain member served. 0 = the model you asked for. */
  fallbackIndex: number;
  [extra: string]: unknown;
}

/** The first text content of the first choice, or `undefined`. Convenience only. */
export function textOf(completion: Completion): string | undefined {
  const content = completion.choices[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Why a completion came back with no text, when it did.
 *
 * `undefined` means there is text and nothing to explain. Otherwise this is a
 * sentence you can log or raise, because an empty string is the single most
 * confusing thing this API returns and the reason is never in the content.
 *
 * THE TRAP THIS EXISTS FOR (measured live 2026-08-27, on BOTH the OpenAI and
 * Anthropic wires). A reasoning model spends `maxTokens` on its thinking block
 * FIRST. Ask `claude-fable-5` for one word with `maxTokens: 20` and you get
 * `content: ""`, `finish_reason: "length"`, and a bill for 20 output tokens —
 * the model never reached the visible answer. Raise it to 200 and the same
 * prompt answers fine, having spent 47 tokens thinking.
 *
 * Nothing about that is a bug, and nothing about it is discoverable: the empty
 * string looks like a refusal, a content filter, or a broken SDK, and the one
 * distinguishing signal is a field most callers never read. So the SDK reads it
 * for you rather than leaving everyone to rediscover it.
 */
export function emptyReason(completion: Completion): string | undefined {
  const choice = completion.choices[0];
  if (choice === undefined) {
    return "the gateway returned no choices at all. If this was a deferred turn, use `defer()` and `jobs.wait()` — a 202 job envelope is not a completion.";
  }
  const content = choice.message?.content;
  if (typeof content === "string" && content !== "") return undefined;
  // A tool call IS the answer. Absent text there is correct, not a failure.
  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    return undefined;
  }
  if (choice.finish_reason === "length") {
    const reasoning = completion.usage?.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoning === "number" && reasoning > 0) {
      return `the model hit maxTokens while still reasoning (${reasoning} of ${completion.usage?.completion_tokens} output tokens went to thinking), so it never reached the visible answer. Raise maxTokens, or set reasoning: { effort: "none" } / "low" on a model that supports it.`;
    }
    return "the model hit maxTokens before emitting visible text. On a reasoning model the thinking block is spent FIRST, so a small maxTokens can be consumed entirely before the answer starts. Raise maxTokens.";
  }
  if (choice.finish_reason === "content_filter") {
    return "the upstream provider's own content filter stopped this turn. Conifer applies no moderation of its own.";
  }
  return `the model returned empty content with finish_reason ${JSON.stringify(choice.finish_reason)}.`;
}

export interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Choice[];
  usage?: Usage;
  [extra: string]: unknown;
}

/**
 * The stream handle: an async iterable of raw chunks plus a terminal receipt.
 *
 * LIB REQUIREMENT, stated because it is easy to hit and confusing to diagnose:
 * `AsyncIterable` lives in `lib.es2018`, so a consumer whose tsconfig targets
 * ES2017 or older sees `TS2583: Cannot find name 'AsyncIterable'` pointing
 * INTO this file. That is not a bug in these types — the official `openai`
 * package fails the same check the same way, because there is no way to
 * describe async iteration without the names that describe it. Target ES2018+
 * (or add `"lib": ["ES2018"]`), which any runtime new enough to run this SDK
 * already supports.
 *
 * An earlier draft tried to dodge this by spelling the iterator out
 * structurally. It did not work — the `[Symbol.asyncIterator]` key is itself
 * ES2018 — and it traded a clear declaration for an obscure one, so it was
 * reverted rather than kept as decoration.
 */
export interface CompletionStream extends AsyncIterable<StreamChunk> {
  /**
   * The receipt for the streamed turn. Resolves when the stream ends.
   * Read it AFTER the loop: the cost is settled at the end, not at the start.
   */
  receipt(): Promise<Receipt>;
  fallbackIndex: number;
}

export interface Pricing {
  [class_: string]: unknown;
}

export interface CatalogModel {
  id: string;
  /** `"conifer"` (credits lane) or `"byok"` (your own key would serve it). */
  endpointKind?: string;
  displayName?: string;
  provider?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxTools?: number;
  /** Declared capabilities. ABSENT means undeclared, NOT unsupported. */
  caps?: string[];
  /**
   * The vector width an embedding seat returns, on rows whose `caps` include
   * `embeddings`.
   *
   * Typed rather than left in `raw` because it is a DDL decision, not a
   * curiosity: a pgvector column is declared `vector(1536)` before the first
   * call, and getting it wrong means a migration on a populated table. The
   * catalog publishes it precisely so you can size the column without spending
   * a token, and `llms.txt` tells agents to do exactly that — so the SDK
   * should not be the one place it is hard to reach.
   *
   * Note this is the seat's NATIVE width. Passing `dimensions` on the request
   * (Matryoshka shortening, where the model supports it) overrides it.
   */
  embeddingDimensions?: number;
  /** The AS-CHARGED price for THIS entry's lane only. */
  pricing?: Pricing;
  /** BYOK take rate as a percent. Display-only. */
  feePct?: number;
  /** True only when BYOK custody is degraded for a provider you hold a key for. */
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

// ----------------------------------------------------------------- embeddings

/**
 * One embeddings turn.
 *
 * The gateway bills embeddings on INPUT ONLY — there is no completion, so
 * there is no output term and the catalog carries a zero output rate for every
 * embedding seat. That is why this request has no `maxTokens`, no sampling
 * knobs and no stream: none of them mean anything here, and offering them
 * would imply a control the wire does not have.
 */
export interface EmbeddingsRequest {
  /** Must DECLARE `caps: ["embeddings"]`. A chat model is refused with a 400 naming the chat door. */
  model: string;
  /**
   * Text, or a batch of texts. A batch returns one vector per member, in the
   * order you sent them.
   *
   * Token-id arrays are NOT accepted: the gateway cannot size a spend hold
   * from token ids it did not tokenize, and serving an unpriced turn is the
   * one thing the money path must never do. Send text.
   */
  input: string | string[];
  /** Matryoshka shortening, on models that support it. Forwarded verbatim; the provider validates it. */
  dimensions?: number;
  /**
   * The WIRE encoding, which is not the same question as what you get back.
   *
   * Leave this alone unless you need the raw provider bytes. The SDK requests
   * `base64` by default and decodes it for you — same numbers, ~3x less
   * network. See {@link Embeddings.create}. Set `"float"` to send JSON floats
   * on the wire, or read `raw` for whatever the provider actually sent.
   */
  encodingFormat?: "float" | "base64";
  /** Opaque end-user id, forwarded verbatim for the provider's own abuse tooling. */
  user?: string;

  /** HARD ceiling on the caller-total worst case, in integer nanodollars. */
  maxCostNanoUsd?: number;
  idempotencyKey?: string;
  requestId?: string;
  /** Your app's name, for your own usage attribution. */
  client?: string;
  headers?: Record<string, string>;
  /** Fields the SDK does not model, merged into the body at your own risk. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Embedding {
  index: number;
  /** The vector, always as numbers, whatever the wire encoding was. */
  embedding: number[];
  object?: string;
  [extra: string]: unknown;
}

export interface EmbeddingsResponse {
  object?: string;
  model?: string;
  data: Embedding[];
  /** Input tokens only. `completion_tokens` is absent because there is no completion. */
  usage?: Usage;
  /** The x-conifer-* disclosure, parsed. Embeddings settle in-band, so the cost IS here. */
  receipt: Receipt;
  /** The provider's own body, untouched — including base64 strings if that is what it sent. */
  raw: Record<string, unknown>;
}

/** The first vector, for the overwhelmingly common single-input call. */
export function vectorOf(response: EmbeddingsResponse): number[] | undefined {
  return response.data[0]?.embedding;
}

// -------------------------------------------------------------- deferred jobs

/**
 * The lifecycle of a deferred job, in the gateway's own words.
 *
 * Four of the seven are TERMINAL, and the distinction is a money question, not
 * a formality: `ended`/`fetched` mean you were charged and there is a result;
 * `expired`, `cancelled` and `failed` all carry a refund of the unfinished
 * work. Never poll a terminal state again — it will not change.
 */
export type JobStatus =
  /** Accepted and debited; waiting for the aggregator. */
  | "queued"
  /** Riding a provider batch. */
  | "submitted"
  /** The result is stored and the money is settled. Fetchable. */
  | "ended"
  /** TERMINAL: the result was fetched. Retention grace runs from here. */
  | "fetched"
  /** TERMINAL: the deadline or retention window passed. */
  | "expired"
  /** TERMINAL: you cancelled it; refunded per the cancel rules. */
  | "cancelled"
  /** TERMINAL: the provider errored this item; fully refunded. */
  | "failed";

/** The states that will never change again. Polling one is a wasted call. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "fetched",
  "expired",
  "cancelled",
  "failed",
];

/** True once a job has reached a state it can never leave. */
export function isTerminalJob(status: JobStatus | string | undefined): boolean {
  return TERMINAL_JOB_STATUSES.includes(status as JobStatus);
}

/**
 * A deferred job, as returned by the 202 accept and by every status poll.
 *
 * Carries no content and no cost: the money is disclosed on the RESULT, which
 * is a separate call.
 */
export interface DeferredJob {
  jobId: string;
  status: JobStatus | string;
  /** Unix seconds. After this the job expires and unfinished work is refunded. */
  deadlineUtc?: number;
  createdUtc?: number;
  /** The model the job was accepted for. */
  model?: string;
  /** The gateway's own poll path, relative to the base URL. */
  pollUrl?: string;
  raw: Record<string, unknown>;
}
