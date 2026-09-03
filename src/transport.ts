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
  /** Silence a streaming body may fall to before it is cut. Default {@link STREAM_IDLE_MS}. */
  streamIdleMs?: number;
}

/**
 * How long a streaming body may go silent before the SDK gives up on it.
 *
 * `timeoutMs` bounds the wait for HEADERS. A stream's body is read by the
 * caller over the minutes that follow, so a second clock is needed there —
 * one that restarts on every byte, because a slow stream is healthy and a
 * silent one is dead. The value is the gateway's own `stream_idle`
 * (`contracts/gateway-contract.json`, `timeouts_secs`): a stream quieter than
 * that is one the gateway has already cut, so waiting longer buys nothing.
 */
export const STREAM_IDLE_MS = 120_000;

/**
 * The abort wiring of a streaming response, kept alive until its body is done.
 *
 * `request()` unhooks the caller's signal and its own timer the moment the
 * response head arrives. That is right for JSON, whose body is read before
 * `request()` returns, and wrong for a stream, whose body the caller reads
 * over the next minutes: the caller's abort stopped applying at the first
 * byte, and a gateway that went silent mid-stream was waited on forever while
 * it kept generating and billing. The lease holds both until `release()`.
 */
export interface StreamLease {
  /** Fires when the caller aborts, or the body goes silent for the idle window. */
  readonly signal: AbortSignal;
  /** Bytes arrived: restart the idle clock. */
  touch(): void;
  /** The body is finished with, however it ended. Idempotent. */
  release(): void;
  /** The typed failure for why `signal` fired. */
  error(): ConiferError;
}

function leaseStream(
  controller: AbortController,
  outer: AbortSignal | undefined,
  idleMs: number,
): StreamLease {
  let why: "caller" | "idle" | undefined;
  let released = false;
  const abort = (cause: "caller" | "idle") => {
    why ??= cause;
    controller.abort();
  };
  const onOuterAbort = () => abort("caller");
  // The idle clock must never be what keeps a process alive: a caller that
  // awaits `stream()` and never iterates (or only reads `receipt()`) never
  // releases the lease, and a ref'd 120 s timer held `node` open for the
  // whole window. Node timers unref; a browser returns a number, hence `?.`.
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
        ? new ConiferTimeoutError(
            `no bytes for ${idleMs}ms mid-stream; the turn may still have been served and billed`,
          )
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
  /** SSE: hand back the raw response instead of parsing JSON. */
  raw?: boolean;
}

/**
 * Statuses a retry can plausibly fix.
 *
 * 409 is here for ONE narrow reason, and only in combination with the error's
 * own `retryable`: the gateway authors two 409s that literally say "retry
 * shortly" (a first attempt still in flight, or a settled body cached on
 * another replica). Those are the gateway asking to be asked again, and asking
 * again is safe precisely because the retry carries the SAME idempotency key —
 * so it either replays the settled response or waits its turn, but cannot bill
 * twice. The third 409, "already used with a different request body", is
 * terminal and `ConiferConflictError` marks it non-retryable, so it never
 * reaches this set's permission.
 */
const RETRYABLE_STATUS = new Set([409, 429, 502, 503, 504]);

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
  request(
    spec: RequestSpec & { raw: true },
  ): Promise<{ data: undefined; response: Response; lease: StreamLease }>;
  request(spec: RequestSpec): Promise<{ data: unknown; response: Response }>;
  async request(
    spec: RequestSpec,
  ): Promise<{ data: unknown; response: Response; lease?: StreamLease }> {
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
          await sleep(backoffMs(attempt), spec.signal);
          if (spec.signal?.aborted) {
            throw new ConiferTimeoutError("the caller aborted this request");
          }
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onOuterAbort);
      }

      if (response.ok) {
        if (spec.raw) {
          // The body is still on the wire. Re-arm the caller's signal on the
          // SAME controller the fetch is bound to, so an abort tears the
          // socket down, and start the idle clock the head timer cannot keep.
          const lease = leaseStream(
            controller,
            spec.signal,
            this.options.streamIdleMs ?? STREAM_IDLE_MS,
          );
          return { data: undefined, response, lease };
        }
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
        // A `retry-after` is honored up to the request's own timeout: a CDN's
        // 3600 would otherwise park the caller for an hour, silently.
        await sleep(
          hinted !== undefined
            ? Math.min(hinted * 1000, this.options.timeoutMs)
            : Math.max(backoffMs(attempt), minimumBackoffMs(response.status)),
          spec.signal,
        );
        if (spec.signal?.aborted) {
          throw new ConiferTimeoutError("the caller aborted this request");
        }
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

/**
 * A floor on the wait for statuses whose recovery is not instant.
 *
 * The default schedule (250ms, 500ms) is tuned for a momentary blip and gives a
 * retryable failure 0.75s of total patience. That is right for a 502, and it is
 * far too impatient for a transient 409: those mean "a first attempt is in
 * flight, or its settled body is on another replica", so the SDK is waiting for
 * CROSS-REPLICA CONVERGENCE, not for a socket to come back.
 *
 * Found in a fresh-install consumer test, which is exactly where it would
 * otherwise have been found — by a new user, on their first call. The turn was
 * being served; the client simply gave up after 0.75s and reported a hard
 * failure for it. With this floor the same case gets ~4.5s across two retries,
 * which covered every occurrence observed.
 *
 * Retrying remains safe because the retry carries the SAME idempotency key: the
 * gateway either replays the settled response or serves the turn once.
 */
export function minimumBackoffMs(status: number): number {
  return status === 409 ? 1_500 : 0;
}

/** A wait the caller's signal can end early; the caller re-checks `aborted`. */
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
