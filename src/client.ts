// client.ts — the Conifer client. Reads cards/sdk.input.card.json, emits
// cards/sdk.output.card.json, and touches the network only through Transport.

import {
  ConiferConflictError,
  ConiferError,
  ConiferPortabilityError,
  ConiferTimeoutError,
} from "./errors.ts";
import { nanoUsdToUsdString, readReceipt, type Receipt } from "./receipt.ts";
import { Transport, type FetchLike } from "./transport.ts";
import {
  isTerminalJob,
  type Balance,
  type CatalogModel,
  type ChatRequest,
  type Completion,
  type CompletionStream,
  type DeferredJob,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type StreamChunk,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.conifer.build";
/** Matches the gateway's own edge silent-cut, so we never quit on a live turn. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/**
 * The narrowest completion window the gateway will accept a deferred job for.
 *
 * Not a client-side convention: the gateway refuses anything smaller with
 * `defer requires a completion window of at least 86400 seconds` (measured
 * live 2026-08-27). Deferred work rides a provider batch, and a batch cannot
 * promise a short turnaround — so a narrow window is refused rather than
 * quietly served synchronously at a different price.
 */
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
  /** `POST /v1/embeddings`. Same receipts, same money ceiling as chat. */
  readonly embeddings: Embeddings;
  /** The deferred-job read/cancel plane. Submit with `defer()`. */
  readonly jobs: JobsApi;

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
    this.embeddings = new Embeddings(this.transport);
    this.jobs = new JobsApi(this.transport);
  }

  /**
   * One chat turn. Returns the completion PLUS its settled receipt — the exact
   * integer nanodollar cost of the call you just made.
   */
  async chat(request: ChatRequest): Promise<Completion> {
    if (request.defer === true) {
      // A deferred turn answers 202 with a JOB ENVELOPE, not a completion.
      // Coercing it into `Completion` is exactly what this SDK used to do, and
      // the result was a turn that had been ACCEPTED AND DEBITED coming back
      // as `choices: []` with `textOf() === undefined` — indistinguishable, at
      // the call site, from a model that answered with nothing. Send people to
      // the method that returns the job.
      throw new ConiferPortabilityError(
        "defer",
        "a deferred turn is accepted with 202 and a job id, not a completion — `chat()` has nothing to return. Call `defer()` for the job, then `jobs.wait(job.jobId)` (or `jobs.status`/`jobs.result`) to collect it.",
      );
    }
    const chain = resolveChain(request);
    let lastError: ConiferError | undefined;
    // One idempotency key for the LOGICAL turn: every transport retry of a
    // chain member reuses it, so a retry cannot bill twice.
    const idempotencyKey = turnIdentity(request);

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

  /**
   * Submit a turn as a DEFERRED JOB, and get the job back.
   *
   * The trade is explicit: you give up an immediate answer, and in exchange the
   * turn rides a provider batch. It is the right shape for work that is not
   * interactive — an overnight re-index, a bulk classification, an eval sweep.
   *
   * The gateway requires a completion window of at least 24 hours (86400s), and
   * refuses a narrower one rather than quietly serving it synchronously; that
   * floor is applied here as the default so the common call just works.
   *
   * The job is ACCEPTED AND DEBITED at submission. Collect it with
   * `jobs.wait(job.jobId)`, or poll `jobs.status` and call `jobs.result`
   * yourself.
   */
  async defer(request: ChatRequest): Promise<DeferredJob> {
    if (request.fallbackModels?.length) {
      // A chain is a sequence of SEPARATE requests decided by watching the
      // first one fail. A deferred job's failure is discovered hours later,
      // by which time "fall back" would mean submitting a second job the
      // caller never asked for.
      throw new ConiferPortabilityError(
        "fallbackModels+defer",
        "a client-side fallback chain cannot be applied to a deferred job: the outcome is not known until the job ends. Submit one job, and handle a `failed` status yourself.",
      );
    }
    const deadlineSeconds = request.deadlineSeconds ?? MIN_DEFER_WINDOW_SECONDS;
    const deferred: ChatRequest = { ...request, defer: true, deadlineSeconds };
    const { data } = await this.transport.request({
      method: "POST",
      path: "/v1/chat/completions",
      body: chatBody(deferred, false),
      headers: chatHeaders(deferred, turnIdentity(request)),
      signal: request.signal,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
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
      headers: chatHeaders(request, turnIdentity(request)),
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

/**
 * The embeddings door: `POST /v1/embeddings`.
 *
 * Reached as `conifer.embeddings.create(...)`, matching the shape every OpenAI
 * client already uses, so a migration is a base-URL change and not a rewrite.
 */
export class Embeddings {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * One embeddings turn, with the exact settled cost of that call.
   *
   * BASE64 BY DEFAULT, DECODED FOR YOU. Unless you ask otherwise, the SDK
   * requests `encoding_format: "base64"` and decodes the result into plain
   * numbers. This is not a micro-optimization: a JSON float array spends ~20
   * bytes per dimension, and the same vector in base64 float32 spends 5.33 —
   * roughly a 3x smaller response, which on a 3072-dimension model batched
   * 100 deep is the difference between ~6 MB and ~1.6 MB per call.
   *
   * It is safe to do this silently ONLY because the transformation is exactly
   * lossless, which was verified against the live gateway rather than assumed:
   * `text-embedding-3-small` returned the identical 1536 values both ways,
   * max absolute difference 0.0. The bytes are little-endian float32, and the
   * JSON arm is float32 widened to double, so the two agree bit for bit. (The
   * official OpenAI Python SDK makes the same call for the same reason.)
   *
   * Pass `encodingFormat: "float"` to send JSON floats instead. Either way,
   * `raw` holds the provider's own body untouched.
   */
  async create(request: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    // Refuse client-side rather than spend a turn discovering it. The gateway
    // refuses token-id input too, but it does so AFTER admission; catching the
    // obvious shape here makes the reason legible at the call site.
    if (Array.isArray(request.input) && request.input.some((item) => typeof item !== "string")) {
      throw new ConiferPortabilityError(
        "input",
        "embeddings input must be text (a string, or an array of strings). Token-id arrays are refused: the gateway cannot size a spend hold from token ids it did not tokenize.",
      );
    }
    const { data, response } = await this.transport.request({
      method: "POST",
      path: "/v1/embeddings",
      body: embeddingsBody(request),
      headers: embeddingsHeaders(request, turnIdentity(request)),
      signal: request.signal,
    });
    const payload = (data ?? {}) as Record<string, unknown>;
    const entries = (payload.data ?? []) as Record<string, unknown>[];
    return {
      object: payload.object as string | undefined,
      model: payload.model as string | undefined,
      data: entries.map((entry, position) => ({
        ...entry,
        index: typeof entry.index === "number" ? entry.index : position,
        embedding: decodeVector(entry.embedding),
      })),
      usage: payload.usage as EmbeddingsResponse["usage"],
      receipt: readReceipt(response.headers),
      raw: payload,
    };
  }
}

/** The embeddings body. No sampling knobs: none of them mean anything here. */
export function embeddingsBody(request: EmbeddingsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    // See Embeddings.create for why base64 is the default and why it is safe.
    encoding_format: request.encodingFormat ?? "base64",
  };
  if (request.dimensions !== undefined) body.dimensions = request.dimensions;
  if (request.user !== undefined) body.user = request.user;
  return { ...body, ...(request.extraBody ?? {}) };
}

/** The embeddings header set. The same money ceiling and attribution as chat. */
export function embeddingsHeaders(
  request: EmbeddingsRequest,
  idempotencyKey: string,
): Record<string, string> {
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
  if (request.requestId !== undefined) headers["x-request-id"] = request.requestId;
  if (request.client !== undefined) headers["x-conifer-client"] = request.client;
  return headers;
}

/**
 * A vector as numbers, from either wire encoding.
 *
 * The base64 arm is little-endian float32, which is what every provider on
 * this door emits and what the OpenAI clients assume. Little-endianness is
 * read explicitly rather than inherited from the host, so this decodes the
 * same on a big-endian machine.
 *
 * An unrecognized shape yields an EMPTY vector rather than a guess. A wrong
 * vector is far worse than an obviously missing one: it would sail through
 * a cosine-similarity call and quietly return nonsense rankings forever.
 */
export function decodeVector(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return [];
  const binary = base64ToBytes(value);
  // float32 is 4 bytes; a length that is not a multiple of 4 is not a vector.
  if (binary.length === 0 || binary.length % 4 !== 0) return [];
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const out = new Array<number>(binary.length / 4);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = view.getFloat32(index * 4, true);
  }
  return out;
}

/** base64 -> bytes, on both Node and the browser/edge runtimes. */
function base64ToBytes(value: string): Uint8Array {
  const fromBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (fromBuffer !== undefined) return new Uint8Array(fromBuffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The idempotency key for one logical turn.
 *
 * THE COLLAPSE (read the gateway's `request_id()`, measured live 2026-08-27).
 * The gateway derives the request id from the FIRST of `idempotency-key` then
 * `x-request-id`. The SDK always sends an idempotency key, so `x-request-id`
 * was never once consulted: a caller who set `requestId` to their own trace id
 * got a generated `idem-<uuid>` back in the receipt and had no way to correlate
 * a support question with their own logs. The field was inert.
 *
 * So on this gateway the two ARE one identity, and the SDK stops pretending
 * otherwise: an explicit `requestId` becomes the idempotency key. That makes
 * the id you chose the id that comes back, in the receipt and in the gateway's
 * own logs.
 *
 * The consequence is real and worth stating: the gateway binds an idempotency
 * key to the request BODY, so reusing one `requestId` across two different
 * bodies is a 409 `request_in_progress` rather than two turns. That is the
 * correct answer to "the same request id for a different request", and it is
 * loud rather than silent. Pass `idempotencyKey` explicitly to control the two
 * separately when your ids are not unique per turn.
 */
export function turnIdentity(request: {
  idempotencyKey?: string;
  requestId?: string;
}): string {
  return request.idempotencyKey ?? request.requestId ?? randomId("idem");
}

/**
 * The deferred-job plane: `conifer.jobs.*`.
 *
 * The accept arm rides `POST /v1/chat/completions` with `defer: true` (see
 * {@link Conifer.defer}); this class owns the read/cancel half.
 *
 * TENANCY, worth knowing before you write a retry loop: a job id belonging to
 * another account and a job id that never existed are the SAME 404. That is
 * deliberate — an existence oracle would leak other people's traffic — so a
 * 404 here means "not yours or not real", never "not yet".
 */
export class JobsApi {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** `GET /v1/deferred/{id}`. Status only; no content, no cost. */
  async status(jobId: string): Promise<DeferredJob> {
    const { data } = await this.transport.request({
      method: "GET",
      path: `/v1/deferred/${encodeURIComponent(jobId)}`,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
  }

  /**
   * `GET /v1/deferred/{id}/result` — the completion, with its settled receipt.
   *
   * Throws `ConiferConflictError` while the job is still running, and ALSO for
   * every terminal state that has no result (cancelled, failed, expired). The
   * message says which, because the money differs: a failed or expired job was
   * refunded, while a result that aged out unfetched was charged and is gone.
   *
   * Fetching is not free of consequence: it moves the job to `fetched` and
   * starts the retention grace, after which the body is deleted.
   */
  async result(jobId: string): Promise<Completion> {
    const { data, response } = await this.transport.request({
      method: "GET",
      path: `/v1/deferred/${encodeURIComponent(jobId)}/result`,
    });
    const payload = (data ?? {}) as Record<string, unknown>;
    return {
      ...payload,
      choices: (payload.choices as Completion["choices"]) ?? [],
      receipt: readReceipt(response.headers),
      fallbackIndex: 0,
    } as Completion;
  }

  /** `POST /v1/deferred/{id}/cancel`. Refunded per the gateway's cancel rules. */
  async cancel(jobId: string): Promise<DeferredJob> {
    const { data } = await this.transport.request({
      method: "POST",
      path: `/v1/deferred/${encodeURIComponent(jobId)}/cancel`,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
  }

  /**
   * Poll until the job ends, then return its result.
   *
   * A convenience over `status`/`result`, written here so every caller does not
   * re-derive the same three rules and get one of them wrong:
   *
   *   1. STOP ON TERMINAL. `expired`, `cancelled` and `failed` never change, so
   *      polling one forever is a loop that cannot exit. Those raise rather
   *      than spin.
   *   2. BACK OFF. A deferred job's whole premise is a long window (the gateway
   *      requires at least 24h), so a tight poll is thousands of pointless
   *      requests. The interval doubles from `pollMs` up to `maxPollMs`.
   *   3. RESPECT THE CALLER'S DEADLINE. `signal` aborts the wait without
   *      cancelling the job — the work continues and can still be fetched.
   *
   * This does NOT cancel on timeout. Cancelling work the caller paid for
   * because a client-side clock ran out is not a decision an SDK should make
   * silently; call `cancel()` if that is what you want.
   */
  async wait(
    jobId: string,
    options: {
      pollMs?: number;
      maxPollMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      onPoll?: (job: DeferredJob) => void;
    } = {},
  ): Promise<Completion> {
    const started = Date.now();
    let interval = options.pollMs ?? 2_000;
    const maxInterval = options.maxPollMs ?? 30_000;

    for (;;) {
      const job = await this.status(jobId);
      options.onPoll?.(job);
      if (job.status === "ended" || job.status === "fetched") {
        return this.result(jobId);
      }
      if (isTerminalJob(job.status)) {
        // Terminal and resultless. Raising with the gateway's own vocabulary
        // beats returning an empty completion the caller has to interpret.
        throw new ConiferConflictError({
          status: 409,
          type: "request_in_progress",
          message: `deferred job ${jobId} ended as "${job.status}" and has no result. Cancelled, failed and expired jobs are refunded for the unfinished work.`,
          body: job.raw,
        });
      }
      if (options.signal?.aborted) {
        throw new ConiferTimeoutError(
          `stopped waiting on deferred job ${jobId}; it is still running and can still be fetched`,
        );
      }
      if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) {
        throw new ConiferTimeoutError(
          `deferred job ${jobId} was still "${job.status}" after ${options.timeoutMs}ms. The job was NOT cancelled: it is still running, and \`jobs.result("${jobId}")\` will return it once it ends.`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * 2, maxInterval);
    }
  }
}

/** The 202/status envelope, parsed. */
export function toDeferredJob(payload: Record<string, unknown>): DeferredJob {
  return {
    jobId: String(payload.job_id ?? ""),
    status: (payload.status as string) ?? "",
    deadlineUtc: payload.deadline_utc as number | undefined,
    createdUtc: payload.created_utc as number | undefined,
    model: payload.model as string | undefined,
    pollUrl: payload.poll_url as string | undefined,
    raw: payload,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // `x-request-id` is sent too, so a proxy or log shipper between you and the
  // gateway still sees the id. The GATEWAY itself reads `idempotency-key`
  // first (see turnIdentity), which is why `requestId` now feeds that key
  // rather than only this header.
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
 * A single comparable number per model, in USD per million tokens.
 *
 * The catalog states prices as DECIMAL STRINGS (`"10"`, `"12.5"`), not numbers
 * — they are money, and a string survives the JSON round-trip that a float
 * would quietly perturb. Parsing them here rather than assuming numbers is not
 * a detail: the first version of this function summed only `typeof === number`
 * and therefore ranked the entire live catalog as unpriced, so `cheapestFor`
 * returned nothing at all.
 *
 * The ranking key weights input and output rather than summing every field,
 * because a flat sum lets a model with cheap input and ruinous output outrank
 * one that is cheaper for any real turn. The 3:1 output:input weighting is a
 * ranking convention, NOT a cost forecast — `receipt.costNanoUsd` is the only
 * authority on what a turn actually cost. Cache rates are excluded: whether
 * they apply is a property of the conversation, not of the model.
 */
export function priceOf(model: CatalogModel): number | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return undefined;
  const input = decimal(pricing.in_usd_per_mtok);
  const output = decimal(pricing.out_usd_per_mtok);
  if (input === undefined && output === undefined) {
    // An unrecognized pricing shape is UNPRICED, not free. Falling back to a
    // sum of whatever numbers happen to be present would rank a model on
    // fields we cannot name.
    return undefined;
  }
  return (input ?? 0) + 3 * (output ?? 0);
}

/** A catalog money value: a decimal string, or a number if one ever appears. */
function decimal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
