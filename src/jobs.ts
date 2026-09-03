// Deferred jobs: the read, wait and cancel half of `conifer.defer()`.

import { toCompletion } from "./chat.ts";
import { ConiferConflictError, ConiferTimeoutError } from "./errors.ts";
import { readReceipt } from "./receipt.ts";
import type { Transport } from "./transport.ts";
import { isTerminalJob, type Completion, type DeferredJob } from "./types.ts";

/**
 * `conifer.jobs.*`. A job id that belongs to another account and one that
 * never existed are the same 404, so a 404 never means "not yet".
 */
export class JobsApi {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** `GET /v1/deferred/{id}`: status only, no content, no cost. */
  async status(jobId: string): Promise<DeferredJob> {
    const { data } = await this.transport.request({
      method: "GET",
      path: `/v1/deferred/${encodeURIComponent(jobId)}`,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
  }

  /**
   * `GET /v1/deferred/{id}/result`: the completion with its receipt. Throws
   * `ConiferConflictError` while the job runs and for terminal states with
   * no result. Fetching starts the retention clock on the body.
   */
  async result(jobId: string): Promise<Completion> {
    const { data, response } = await this.transport.request({
      method: "GET",
      path: `/v1/deferred/${encodeURIComponent(jobId)}/result`,
    });
    return toCompletion(data, readReceipt(response.headers), 0);
  }

  /** `POST /v1/deferred/{id}/cancel`. Unfinished work is refunded. */
  async cancel(jobId: string): Promise<DeferredJob> {
    const { data } = await this.transport.request({
      method: "POST",
      path: `/v1/deferred/${encodeURIComponent(jobId)}/cancel`,
    });
    return toDeferredJob((data ?? {}) as Record<string, unknown>);
  }

  /**
   * Poll with exponential backoff until the job ends, then return its result.
   * Terminal states with no result throw. A timeout or abort stops waiting
   * but never cancels the job: call `cancel()` for that.
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
      if (job.status === "ended" || job.status === "fetched") return this.result(jobId);
      if (isTerminalJob(job.status)) {
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
          `deferred job ${jobId} was still "${job.status}" after ${options.timeoutMs}ms. The job was NOT cancelled: \`jobs.result("${jobId}")\` will return it once it ends.`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * 2, maxInterval);
    }
  }
}

/** The 202 and status envelope. */
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
