// client.ts — the Conifer client. Reads cards/sdk.input.card.json, emits
// cards/sdk.output.card.json, and touches the network only through Transport.

import {
  ConiferError,
  ConiferPortabilityError,
} from "./errors.ts";
import { nanoUsdToUsdString, readReceipt, type Receipt } from "./receipt.ts";
import { Transport, type FetchLike } from "./transport.ts";
import type {
  Balance,
  CatalogModel,
  ChatRequest,
  Completion,
  CompletionStream,
  StreamChunk,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.conifer.build";
/** Matches the gateway's own edge silent-cut, so we never quit on a live turn. */
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface ConiferOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
}

/**
 * Resolve the gateway origin.
 *
 * `CONIFER_BASE_URL` wins. `OPENAI_BASE_URL` is honored ONLY when it already
 * points at a Conifer host — a drop-in env should survive adopting the SDK, but
 * a stray OpenAI base URL must never silently redirect Conifer traffic to
 * someone else's gateway with a Conifer key in the header.
 */
export function resolveBaseUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const chosen =
    explicit ??
    env.CONIFER_BASE_URL ??
    (isConiferHost(env.OPENAI_BASE_URL) ? env.OPENAI_BASE_URL : undefined) ??
    DEFAULT_BASE_URL;
  // The SDK owns the /v1 suffix (the Anthropic door has none), so strip it.
  return chosen.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function isConiferHost(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    return new URL(url).hostname.endsWith("conifer.build");
  } catch {
    return false;
  }
}

export class Conifer {
  readonly transport: Transport;
  /** BYOK custody: your own provider keys, held by the gateway. */
  readonly keys: KeysApi;

  constructor(options: ConiferOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
    const apiKey = options.apiKey ?? env.CONIFER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new ConiferError({
        status: 0,
        type: "missing_api_key",
        message:
          "CONIFER_API_KEY is missing. Mint one at https://conifer.build/console#/keys and pass it as `apiKey` or set the environment variable.",
      });
    }
    const fetchImpl =
      options.fetch ??
      (globalThis.fetch as unknown as FetchLike | undefined);
    if (fetchImpl === undefined) {
      throw new ConiferError({
        status: 0,
        type: "no_fetch",
        message:
          "no global fetch in this runtime; pass one as `fetch` (node >= 18 or undici)",
      });
    }
    this.transport = new Transport({
      baseUrl: resolveBaseUrl(options.baseUrl, env),
      apiKey,
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? 2,
      defaultHeaders: options.defaultHeaders ?? {},
    });
    this.keys = new KeysApi(this.transport);
  }

  /**
   * One chat turn. Returns the completion PLUS its settled receipt — the exact
   * integer nanodollar cost of the call you just made.
   */
  async chat(request: ChatRequest): Promise<Completion> {
    const chain = resolveChain(request);
    let lastError: ConiferError | undefined;
    // One idempotency key for the LOGICAL turn: every transport retry of a
    // chain member reuses it, so a retry cannot bill twice.
    const idempotencyKey = request.idempotencyKey ?? randomId("idem");

    for (let index = 0; index < chain.length; index += 1) {
      const model = chain[index] as string;
      try {
        const { data, response } = await this.transport.request({
          method: "POST",
          path: "/v1/chat/completions",
          body: chatBody({ ...request, model }, false),
          // A chain member is a DIFFERENT body, so it gets its own derived key.
          headers: chatHeaders(request, index === 0 ? idempotencyKey : `${idempotencyKey}-${index}`),
          signal: request.signal,
        });
        const payload = (data ?? {}) as Record<string, unknown>;
        return {
          ...payload,
          choices: (payload.choices as Completion["choices"]) ?? [],
          receipt: readReceipt(response.headers),
          fallbackIndex: index,
        } as Completion;
      } catch (error) {
        if (!(error instanceof ConiferError)) throw error;
        lastError = error;
        // Only a retryable refusal advances the chain. A 402, a 400, or a
        // model-not-found is the caller's problem on every member alike, and
        // spending on a second model would not fix it.
        if (!error.retryable || index === chain.length - 1) throw error;
      }
    }
    /* c8 ignore next */
    throw lastError ?? new ConiferError({ status: 0, type: "empty_chain", message: "no model to call" });
  }

  /** The same turn, streamed. The receipt resolves when the stream ends. */
  async stream(request: ChatRequest): Promise<CompletionStream> {
    if (request.fallbackModels?.length) {
      // Be honest about the boundary: once bytes are flowing the turn is
      // already committed, so a mid-stream switch would be a second billed
      // turn stitched onto the first without the caller seeing the seam.
      throw new ConiferPortabilityError(
        "fallbackModels+stream",
        "a client-side fallback chain cannot be applied to a stream: the first token commits the turn. Call chat() for a chain, or handle the failure and re-stream yourself.",
      );
    }
    const { response } = await this.transport.request({
      method: "POST",
      path: "/v1/chat/completions",
      body: chatBody(request, true),
      headers: chatHeaders(request, request.idempotencyKey ?? randomId("idem")),
      signal: request.signal,
      raw: true,
    });
    return makeStream(response);
  }

  /** `GET /v1/models`, projected without loss (`raw` keeps every field). */
  async models(): Promise<CatalogModel[]> {
    const { data } = await this.transport.request({ method: "GET", path: "/v1/models" });
    const entries = ((data as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];
    return entries.map(toCatalogModel);
  }

  /** One catalog entry, or a 404 that cannot tell you whether it exists. */
  async model(id: string): Promise<CatalogModel> {
    const { data } = await this.transport.request({
      method: "GET",
      path: `/v1/models/${encodeURIComponent(id)}`,
    });
    return toCatalogModel((data ?? {}) as Record<string, unknown>);
  }

  /** Remaining spendable credit for the authenticated caller. Never writes. */
  async balance(): Promise<Balance> {
    const { data } = await this.transport.request({ method: "GET", path: "/v1/balance" });
    const payload = (data ?? {}) as Record<string, number>;
    const remaining = payload.remaining_nanodollars ?? 0;
    return {
      remainingNanoUsd: remaining,
      includedNanoUsd: payload.included_nanodollars,
      allowanceRemainingNanoUsd: payload.allowance_remaining_nanodollars,
      creditsRemainingNanoUsd: payload.credits_remaining_nanodollars,
      remainingUsd: nanoUsdToUsdString(remaining),
    };
  }

  /**
   * Cheapest catalog entry that DECLARES every capability asked for.
   *
   * The honesty rule: a model with NO declared caps is skipped rather than
   * assumed capable, and a model with no price is skipped rather than assumed
   * free. This picks among what the catalog actually says, which is why it can
   * live client-side without becoming a second router.
   */
  async cheapestFor(caps: string[] = [], options: { minContextWindow?: number } = {}): Promise<CatalogModel | undefined> {
    const models = await this.models();
    return pickCheapest(models, caps, options);
  }
}

/** BYOK custody. Your provider key lives on your account; callers keep using CONIFER_API_KEY. */
export class KeysApi {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Metadata only — never the key material. */
  async list(): Promise<unknown> {
    const { data } = await this.transport.request({ method: "GET", path: "/v1/keys" });
    return data;
  }

  async put(provider: string, apiKey: string, baseUrl?: string): Promise<unknown> {
    const { data } = await this.transport.request({
      method: "PUT",
      path: `/v1/keys/${encodeURIComponent(provider)}`,
      body: baseUrl === undefined ? { api_key: apiKey } : { api_key: apiKey, base_url: baseUrl },
    });
    return data;
  }

  /** Hard delete. */
  async remove(provider: string): Promise<unknown> {
    const { data } = await this.transport.request({
      method: "DELETE",
      path: `/v1/keys/${encodeURIComponent(provider)}`,
    });
    return data;
  }
}

/** The ordered model chain for one logical turn. */
export function resolveChain(request: ChatRequest): string[] {
  const fallbacks = request.fallbackModels ?? [];
  if (fallbacks.length === 0) return [request.model];
  if (request.allowClientFallback !== true) {
    throw new ConiferPortabilityError(
      "fallbackModels",
      "Conifer's gateway admits exactly the model you name, so a fallback list is a CLIENT-SIDE chain of separate billed requests. Pass `allowClientFallback: true` to accept that, or drop the list.",
    );
  }
  return [request.model, ...fallbacks];
}

/** The JSON body, built from the request card's body-mapped fields only. */
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
  if (request.deadlineSeconds !== undefined) {
    body.completion_window_seconds = request.deadlineSeconds;
  }
  if (request.defer === true) body.defer = "allow";
  if (stream) {
    body.stream = true;
    // Always ask for the terminal usage chunk: a streamed turn that cannot
    // report its own tokens is a turn the caller cannot reconcile.
    body.stream_options = { include_usage: true };
  }
  return { ...body, ...(request.extraBody ?? {}) };
}

/** The header set, built from the request card's header-mapped fields only. */
export function chatHeaders(request: ChatRequest, idempotencyKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(request.headers ?? {}),
    "idempotency-key": idempotencyKey,
  };
  if (request.maxCostNanoUsd !== undefined) {
    if (!Number.isInteger(request.maxCostNanoUsd)) {
      throw new ConiferPortabilityError(
        "maxCostNanoUsd",
        "the cost ceiling is an INTEGER nanodollar amount ($1 = 1e9). A fractional value is refused rather than rounded, because rounding a spend limit is the wrong direction half the time.",
      );
    }
    headers["x-conifer-max-cost-nanousd"] = String(request.maxCostNanoUsd);
  }
  if (request.deadlineSeconds !== undefined) {
    headers["x-conifer-deadline"] = String(request.deadlineSeconds);
  }
  if (request.defer === true) headers["x-conifer-defer"] = "allow";
  if (request.venue !== undefined) headers["x-conifer-venue"] = request.venue;
  if (request.promptCache === "off") headers["x-conifer-cache"] = "off";
  if (request.requestId !== undefined) headers["x-request-id"] = request.requestId;
  if (request.client !== undefined) headers["x-conifer-client"] = request.client;
  return headers;
}

/** Parse the OpenAI catalog entry into the output card's shape, losing nothing. */
export function toCatalogModel(entry: Record<string, unknown>): CatalogModel {
  return {
    id: String(entry.id ?? ""),
    endpointKind: entry.endpoint_kind as string | undefined,
    displayName: entry.display_name as string | undefined,
    provider: entry.provider as string | undefined,
    contextWindow: entry.context_window as number | undefined,
    maxOutputTokens: entry.max_output_tokens as number | undefined,
    maxTools: entry.max_tools as number | undefined,
    caps: entry.caps as string[] | undefined,
    pricing: entry.pricing as CatalogModel["pricing"],
    feePct: entry.fee_pct as number | undefined,
    unavailable: entry.unavailable as boolean | undefined,
    raw: entry,
  };
}

/**
 * The cheapest DECLARED-capable model. Exported so it can be tested without a
 * network, and so the MCP server reuses this exact rule rather than a copy.
 */
export function pickCheapest(
  models: CatalogModel[],
  caps: string[],
  options: { minContextWindow?: number } = {},
): CatalogModel | undefined {
  const eligible = models.filter((model) => {
    if (model.unavailable === true) return false;
    if (options.minContextWindow !== undefined) {
      if (model.contextWindow === undefined) return false;
      if (model.contextWindow < options.minContextWindow) return false;
    }
    if (caps.length === 0) return true;
    // Undeclared caps are UNKNOWN, not "yes". Skipping is the honest move.
    if (model.caps === undefined) return false;
    return caps.every((cap) => model.caps?.includes(cap));
  });
  const priced = eligible.filter((model) => priceOf(model) !== undefined);
  priced.sort((a, b) => (priceOf(a) as number) - (priceOf(b) as number));
  return priced[0];
}

/**
 * A single comparable number per model: the sum of its declared per-token
 * rates. Not a forecast of a turn's cost — a ranking key, and only among
 * entries whose prices the catalog actually stated.
 */
export function priceOf(model: CatalogModel): number | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return undefined;
  const values = Object.values(pricing).filter(
    (value): value is number => typeof value === "number",
  );
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

/** Wrap an SSE response as an async iterable of chunks plus a terminal receipt. */
function makeStream(response: Response): CompletionStream {
  const receipt = readReceipt(response.headers);
  let resolveReceipt: (value: Receipt) => void = () => {};
  const receiptPromise = new Promise<Receipt>((resolve) => {
    resolveReceipt = resolve;
  });

  async function* iterate(): AsyncGenerator<StreamChunk> {
    const body = response.body;
    if (body === null) {
      resolveReceipt(receipt);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const chunk = parseFrame(frame);
          if (chunk !== undefined) yield chunk;
          boundary = buffer.indexOf("\n\n");
        }
      }
      const tail = parseFrame(buffer);
      if (tail !== undefined) yield tail;
    } finally {
      // The cost is disclosed on the response HEAD, which we already read; the
      // promise exists so the caller has one obvious place to await it.
      resolveReceipt(receipt);
      reader.releaseLock();
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    receipt: () => receiptPromise,
    fallbackIndex: 0,
  };
}

/** One SSE frame -> one chunk. `[DONE]`, comments, and blanks yield nothing. */
export function parseFrame(frame: string): StreamChunk | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (data === "" || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as StreamChunk;
  } catch {
    return undefined;
  }
}

function randomId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${uuid}`;
}
