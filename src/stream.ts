// Streaming: an SSE response as an async iterable of chunks, with the
// receipt available before the first token.

import { errorFrom } from "./errors.ts";
import { readReceipt } from "./receipt.ts";
import type { StreamLease } from "./transport.ts";
import type { CompletionStream, StreamChunk } from "./types.ts";

/** An SSE event ends at a blank line, with either line ending. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;
const DONE = Symbol("done");

/**
 * Wrap a streaming response. An error frame is thrown as the matching
 * `ConiferError`. Leaving the loop early, throwing, or aborting cancels the
 * body so the gateway stops generating and billing.
 */
export function makeStream(response: Response, lease: StreamLease): CompletionStream {
  const receipt = Promise.resolve(readReceipt(response.headers));

  const accept = (frame: string): StreamChunk | typeof DONE | undefined => {
    const chunk = decodeFrame(frame);
    if (chunk !== undefined && chunk !== DONE && isErrorFrame(chunk)) {
      throw errorFrom(response.status, chunk, response.headers);
    }
    return chunk;
  };

  let cancelReader: (() => Promise<void>) | undefined;

  async function* iterate(): AsyncGenerator<StreamChunk> {
    const body = response.body;
    if (body === null) {
      lease.release();
      return;
    }
    const reader = body.getReader();
    let cancelled: Promise<void> | undefined;
    const cancel = () => (cancelled ??= reader.cancel().catch(() => undefined));
    cancelReader = cancel;
    lease.signal.addEventListener("abort", cancel);
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    try {
      for (;;) {
        if (lease.signal.aborted) throw lease.error();
        if (cancelled !== undefined) return;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (cause) {
          if (lease.signal.aborted) throw lease.error();
          throw cause;
        }
        if (lease.signal.aborted) throw lease.error();
        if (result.done) break;
        lease.touch();
        buffer += decoder.decode(result.value, { stream: true });
        let boundary = FRAME_BOUNDARY.exec(buffer);
        while (boundary !== null) {
          // A consumer can cancel while suspended at the previous yield,
          // even when the next frame has already arrived in the same read.
          if (lease.signal.aborted) throw lease.error();
          if (cancelled !== undefined) return;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const chunk = accept(frame);
          if (chunk === DONE) return;
          if (chunk !== undefined) yield chunk;
          boundary = FRAME_BOUNDARY.exec(buffer);
        }
      }
      if (lease.signal.aborted) throw lease.error();
      if (cancelled !== undefined) return;
      const tail = accept(buffer);
      if (tail !== undefined && tail !== DONE) yield tail;
      finished = true;
    } finally {
      lease.signal.removeEventListener("abort", cancel);
      if (!finished) await cancel();
      lease.release();
      reader.releaseLock();
    }
  }

  return {
    [Symbol.asyncIterator]: iterate,
    receipt: () => receipt,
    async cancel() {
      lease.release();
      if (cancelReader !== undefined) {
        await cancelReader();
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    },
    fallbackIndex: 0,
  };
}

function isErrorFrame(chunk: StreamChunk): boolean {
  return chunk.error !== undefined && chunk.error !== null && chunk.choices === undefined;
}

/**
 * One SSE frame to one chunk. `[DONE]`, comments and blank frames yield
 * nothing. Several `data:` lines join with a newline, per the SSE spec.
 */
export function parseFrame(frame: string): StreamChunk | undefined {
  const chunk = decodeFrame(frame);
  return chunk === DONE ? undefined : chunk;
}

/** Keep the terminator distinct from an ignored frame inside the iterator. */
function decodeFrame(frame: string): StreamChunk | typeof DONE | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n").trim();
  if (data === "[DONE]") return DONE;
  if (data === "") return undefined;
  try {
    const chunk: unknown = JSON.parse(data);
    return typeof chunk === "object" && chunk !== null && !Array.isArray(chunk)
      ? chunk as StreamChunk
      : undefined;
  } catch {
    return undefined;
  }
}
