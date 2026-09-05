// The Conifer client. Network access goes through Transport; the wire shapes
// live in chat.ts, embeddings.ts, jobs.ts and route.ts.

import { chatBody, chatHeaders, resolveChain, toCompletion, turnIdentity } from "./chat.ts";
import { pickCheapest, toCatalogModel } from "./catalog.ts";
import { Embeddings } from "./embeddings.ts";
import { ConiferCapabilityError, ConiferError, ConiferPortabilityError } from "./errors.ts";
import { JobsApi, toDeferredJob } from "./jobs.ts";
import { KeysApi } from "./keys.ts";
import { nanoUsdToUsdString, readReceipt } from "./receipt.ts";
import { routeBody, toRouteDecision } from "./route.ts";
import { makeStream } from "./stream.ts";
import { Transport, type FetchLike } from "./transport.ts";
import type {
  Balance,
  CatalogModel,
  ChatRequest,
  Completion,
  CompletionStream,
  DeferredJob,
  RouteDecision,
  RouteRequest,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.conifer.build";
/** Matches the gateway's own edge cut, so the client never quits on a live turn. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** The gateway refuses a deferred completion window shorter than 24 hours. */
export const MIN_DEFER_WINDOW_SECONDS = 86_400;

export interface ConiferOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
}

/**
 * The gateway origin. `CONIFER_BASE_URL` wins; `OPENAI_BASE_URL` is honoured
 * only when it uses HTTPS on a Conifer host, so a stray OpenAI base URL
 * never sends a Conifer key somewhere else.
 */
export function resolveBaseUrl(explicit: string | undefined, env: Record<string, string | undefined>): string {
  const chosen =
    explicit ??
    env.CONIFER_BASE_URL ??
    (isConiferHost(env.OPENAI_BASE_URL) ? env.OPENAI_BASE_URL : undefined) ??
    DEFAULT_BASE_URL;
  return chosen.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function isConiferHost(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      (parsed.hostname === "conifer.build" || parsed.hostname.endsWith(".conifer.build"));
  } catch {
    return false;
  }
}

export class Conifer {
  readonly transport: Transport;
  /** Your own provider keys, held by the gateway. */
  readonly keys: KeysApi;
  /** `POST /v1/embeddings`. */
  readonly embeddings: Embeddings;
  /** Deferred jobs: status, result, wait, cancel. Submit with `defer()`. */
  readonly jobs: JobsApi;

  constructor(options: ConiferOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const apiKey = options.apiKey ?? env.CONIFER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new ConiferError({
        status: 0,
        type: "missing_api_key",
        message:
          "CONIFER_API_KEY is missing. Mint one at https://conifer.build/console#/keys and pass it as `apiKey` or set the environment variable.",
      });
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (fetchImpl === undefined) {
      throw new ConiferError({
        status: 0,
        type: "no_fetch",
        message: "no global fetch in this runtime; pass one as `fetch` (node >= 18 or undici)",
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
    this.embeddings = new Embeddings(this.transport);
    this.jobs = new JobsApi(this.transport);
  }

  /** One chat turn, with the exact settled cost in `receipt`. */
  async chat(request: ChatRequest): Promise<Completion> {
    if (request.defer === true) {
      throw new ConiferPortabilityError(
        "defer",
        "a deferred turn returns a job, not a completion. Call `defer()` for the job, then `jobs.wait(job.jobId)` to collect it.",
      );
    }
    const chain = resolveChain(request);
    const idempotencyKey = turnIdentity(request);
    let lastError: ConiferError | undefined;

    for (let index = 0; index < chain.length; index += 1) {
      const model = chain[index] as string;
      try {
        const { data, response } = await this.transport.request({
          method: "POST",
          path: "/v1/chat/completions",
          body: chatBody({ ...request, model }, false),
          headers: chatHeaders(request, index === 0 ? idempotencyKey : `${idempotencyKey}-${index}`),
          signal: request.signal,
        });
        return toCompletion(data, readReceipt(response.headers), index);
      } catch (error) {
        if (!(error instanceof ConiferError)) throw error;
        lastError = error;
        // A retryable failure or a capability refusal moves to the next model.
        // Anything else (402, auth, a bad body) would fail on every model alike.
        const advances = error.retryable || error instanceof ConiferCapabilityError;
        if (!advances || index === chain.length - 1) throw error;
      }
    }
    /* c8 ignore next */
    throw lastError ?? new ConiferError({ status: 0, type: "empty_chain", message: "no model to call" });
  }

  /**
   * Submit a turn as a deferred job. The job is accepted and debited now and
   * rides a provider batch; collect it with `jobs.wait(job.jobId)`.
   */
  async defer(request: ChatRequest): Promise<DeferredJob> {
    if (request.serverFallbackModels?.length) {
      throw new ConiferPortabilityError(
        "serverFallbackModels+defer",
        "a fallback chain cannot ride a deferred job: its outcome is not known until it ends. Submit one job and handle a `failed` status.",
      );
    }
    if (request.fallbackModels?.length) {
      throw new ConiferPortabilityError(
        "fallbackModels+defer",
        "a client-side fallback chain cannot be applied to a deferred job: its outcome is not known until it ends. Submit one job and handle a `failed` status.",
      );
    }
    const deferred: ChatRequest = {
      ...request,
      defer: true,
      deadlineSeconds: request.deadlineSeconds ?? MIN_DEFER_WINDOW_SECONDS,
    };
    const { data } = await this.transport.request({
      method: "POST",
      path: "/v1/chat/completions",
      body: chatBody(deferred, false),
      headers: chatHeaders(deferred, turnIdentity(request)),
      signal: request.signal,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
  }

  /** The same turn, streamed. The receipt is readable before the first token. */
  async stream(request: ChatRequest): Promise<CompletionStream> {
    if (request.fallbackModels?.length) {
      throw new ConiferPortabilityError(
        "fallbackModels+stream",
        "a client-side fallback chain cannot be applied to a stream: the first token commits the turn. Call chat() for a chain.",
      );
    }
    const { response, lease } = await this.transport.request({
      method: "POST",
      path: "/v1/chat/completions",
      body: chatBody(request, true),
      headers: chatHeaders(request, turnIdentity(request)),
      signal: request.signal,
      raw: true,
    });
    return makeStream(response, lease);
  }

  /** `GET /v1/models`: the catalog this key can call, with prices. */
  async models(): Promise<CatalogModel[]> {
    const { data } = await this.transport.request({ method: "GET", path: "/v1/models" });
    const entries = ((data as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];
    return entries.map(toCatalogModel);
  }

  /** One catalog entry. A 404 does not say whether the id exists. */
  async model(id: string): Promise<CatalogModel> {
    const { data } = await this.transport.request({
      method: "GET",
      path: `/v1/models/${encodeURIComponent(id)}`,
    });
    return toCatalogModel((data ?? {}) as Record<string, unknown>);
  }

  /** `GET /v1/balance`: remaining spendable credit. Never writes. */
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

  /** The cheapest catalog model that declares every capability in `caps`. */
  async cheapestFor(caps: string[] = [], options: { minContextWindow?: number } = {}): Promise<CatalogModel | undefined> {
    return pickCheapest(await this.models(), caps, options);
  }

  /**
   * `POST /v1/route`: the router's pick for a query, without the completion.
   * Free. To route and complete in one call, send `model: "auto"` to `chat()`
   * and read `receipt.effectiveModel`. A 503 means the router did not answer.
   */
  async route(request: RouteRequest): Promise<RouteDecision> {
    const { data } = await this.transport.request({
      method: "POST",
      path: "/v1/route",
      body: routeBody(request),
    });
    return toRouteDecision((data ?? {}) as Record<string, unknown>);
  }
}
