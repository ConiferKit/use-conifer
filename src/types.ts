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

export interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Choice[];
  usage?: Usage;
  [extra: string]: unknown;
}

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
