// transport.ts — the ONE place the SDK touches the network.
//
// Everything above this file builds a request description; everything below is
// the injected `fetch`. Two properties are load-bearing and live only here:
//
//   1. RETRY IS NARROW. Only transport faults and 429/502/503/504 are retried.
//      A 4xx the gateway authored refuses the same bytes again, so retrying it
//      buys nothing and burns rate limit. (The gateway maps a non-retryable
//      upstream 4xx to 422 for precisely this reason.)
//   2. A RETRY CANNOT DOUBLE-BILL. Every retry of one logical POST carries the
//      SAME idempotency key, which the gateway binds to the request body. If a
//      retry races a first attempt that actually settled, the gateway answers
//      the conflict rather than charging twice.

import {
  ConiferConnectionError,
  ConiferError,
  ConiferTimeoutError,
  errorFrom,
} from "./errors.ts";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
}

export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** SSE: hand back the raw response instead of parsing JSON. */
  raw?: boolean;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class Transport {
  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** Headers every request carries. The credential can never be overwritten. */
  private headersFor(spec: RequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.options.defaultHeaders,
      ...(spec.headers ?? {}),
      authorization: `Bearer ${this.options.apiKey}`,
    };
    if (spec.body !== undefined) headers["content-type"] = "application/json";
    headers.accept = spec.raw ? "text/event-stream" : "application/json";
    return headers;
  }

  /**
   * One request, with the narrow retry above.
   *
   * The abort signal is the CLIENT's deadline, defaulted to the gateway's own
   * 300s edge silent-cut so we never give up on a turn still being served.
   */
  async request(spec: RequestSpec): Promise<{ data: unknown; response: Response }> {
    const url = `${this.options.baseUrl}${spec.path}`;
    const headers = this.headersFor(spec);
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    let lastError: ConiferError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const onOuterAbort = () => controller.abort();
      spec.signal?.addEventListener("abort", onOuterAbort);
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          method: spec.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        // A caller's own abort is their decision, not a fault to retry.
        if (spec.signal?.aborted) {
          throw new ConiferTimeoutError("the caller aborted this request");
        }
        lastError = controller.signal.aborted
          ? new ConiferTimeoutError(
              `no response within ${this.options.timeoutMs}ms; the turn may still have been served and billed`,
            )
          : new ConiferConnectionError(
              `could not reach the gateway at ${url}`,
              cause,
            );
        if (attempt < this.options.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onOuterAbort);
      }

      if (response.ok) {
        if (spec.raw) return { data: undefined, response };
        return { data: await parseJson(response), response };
      }

      const failure = errorFrom(
        response.status,
        await parseJson(response).catch(() => undefined),
        response.headers,
      );
      const retryable =
        failure.retryable && RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt < this.options.maxRetries) {
        const hinted = (failure as { retryAfterSeconds?: number }).retryAfterSeconds;
        await sleep(hinted !== undefined ? hinted * 1000 : backoffMs(attempt));
        lastError = failure;
        continue;
      }
      throw failure;
    }

    /* c8 ignore next */
    throw lastError ?? new ConiferConnectionError("request loop exhausted", undefined);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { type: `http_${response.status}`, message: text.slice(0, 500) } };
  }
}

/** Exponential backoff with jitter: 250ms, 500ms, 1s, … */
export function backoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt;
  return base + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
