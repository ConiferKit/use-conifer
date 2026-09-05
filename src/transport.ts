// The one place the SDK touches the network. Retries are narrow (transport
// faults and 429/5xx, plus the 409s that say "retry shortly") and every retry
// of a POST reuses its idempotency key, so a retry cannot bill twice.

import { ConiferConnectionError, ConiferError, ConiferTimeoutError, errorFrom } from "./errors.ts";

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
  /** How long a streaming body may stay silent before it is cut. Default `STREAM_IDLE_MS`. */
  streamIdleMs?: number;
}

/**
 * `timeoutMs` bounds the wait for headers. A stream's body is read afterwards
 * over minutes, so it has its own idle clock that restarts on every byte.
 * This matches the gateway's own stream idle cut.
 */
export const STREAM_IDLE_MS = 120_000;

/** Keeps the caller's abort and the idle clock attached to a streaming body until it is done. */
export interface StreamLease {
  /** Fires on the caller's abort, or after `streamIdleMs` of silence. */
  readonly signal: AbortSignal;
  /** Bytes arrived: restart the idle clock. */
  touch(): void;
  /** The body is finished with. Idempotent. */
  release(): void;
  /** Why `signal` fired, as a typed error. */
  error(): ConiferError;
}

function leaseStream(controller: AbortController, outer: AbortSignal | undefined, idleMs: number): StreamLease {
  let why: "caller" | "idle" | undefined;
  let released = false;
  const abort = (cause: "caller" | "idle") => {
    why ??= cause;
    controller.abort();
  };
  const onOuterAbort = () => abort("caller");
  // Unref'd so an un-iterated stream never keeps a process alive.
  const arm = () => {
    const timer = setTimeout(() => abort("idle"), idleMs);
    (timer as { unref?(): void }).unref?.();
    return timer;
  };
  let idle = arm();
  if (outer?.aborted) abort("caller");
  else outer?.addEventListener("abort", onOuterAbort);
  return {
    signal: controller.signal,
    touch() {
      if (released) return;
      clearTimeout(idle);
      idle = arm();
    },
    release() {
      released = true;
      clearTimeout(idle);
      outer?.removeEventListener("abort", onOuterAbort);
    },
    error() {
      return why === "idle"
        ? new ConiferTimeoutError(`no bytes for ${idleMs}ms mid-stream; the turn may still have been served and billed`)
        : new ConiferTimeoutError("the caller aborted this stream");
    },
  };
}

export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the raw response for SSE instead of parsing JSON. */
  raw?: boolean;
}

/** Statuses a retry can fix. 409 only counts when the error itself is retryable. */
const RETRYABLE_STATUS = new Set([409, 429, 502, 503, 504]);

export class Transport {
  private readonly options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

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

  request(spec: RequestSpec & { raw: true }): Promise<{ data: undefined; response: Response; lease: StreamLease }>;
  request(spec: RequestSpec): Promise<{ data: unknown; response: Response }>;
  async request(spec: RequestSpec): Promise<{ data: unknown; response: Response; lease?: StreamLease }> {
    const url = `${this.options.baseUrl}${spec.path}`;
    const headers = this.headersFor(spec);
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    let lastError: ConiferError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const onOuterAbort = () => controller.abort();
      spec.signal?.addEventListener("abort", onOuterAbort);
      let response: Response;
      let data: unknown;
      try {
        try {
          response = await this.options.fetch(url, { method: spec.method, headers, body, signal: controller.signal });
        } catch (cause) {
          if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
          lastError = controller.signal.aborted
            ? new ConiferTimeoutError(
                `no response within ${this.options.timeoutMs}ms; the turn may still have been served and billed`,
              )
            : new ConiferConnectionError(`could not reach the gateway at ${url}`, cause);
          if (attempt < this.options.maxRetries) {
            await sleep(backoffMs(attempt), spec.signal);
            if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
            continue;
          }
          throw lastError;
        } finally {
          clearTimeout(timer);
        }

        if (response.ok && spec.raw) {
          const lease = leaseStream(controller, spec.signal, this.options.streamIdleMs ?? STREAM_IDLE_MS);
          return { data: undefined, response, lease };
        }

        // Headers end the timeout, but the caller still owns cancellation
        // until the JSON body has finished (including an HTTP error body).
        data = await parseJson(response).catch((cause: unknown) => {
          if (response.ok) throw cause;
          return undefined;
        });
        if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
      } catch (cause) {
        if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
        throw cause;
      } finally {
        spec.signal?.removeEventListener("abort", onOuterAbort);
      }

      if (response.ok) return { data, response };

      const failure = errorFrom(response.status, data, response.headers);
      const retryable = failure.retryable && RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt < this.options.maxRetries) {
        const hinted = (failure as { retryAfterSeconds?: number }).retryAfterSeconds;
        // `retry-after` is honoured up to the request's own timeout.
        await sleep(
          hinted !== undefined
            ? Math.min(hinted * 1000, this.options.timeoutMs)
            : Math.max(backoffMs(attempt), minimumBackoffMs(response.status)),
          spec.signal,
        );
        if (spec.signal?.aborted) throw new ConiferTimeoutError("the caller aborted this request");
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

/** Exponential backoff with jitter: 250 ms, 500 ms, 1 s, ... */
export function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt + Math.floor(Math.random() * 100);
}

/** A transient 409 waits on cross-replica convergence, not a socket, so it gets a longer floor. */
export function minimumBackoffMs(status: number): number {
  return status === 409 ? 1_500 : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
