// The response keepalive. A non-streaming answer still running after 285 s is
// committed by the gateway as a provisional 200 with `x-conifer-keepalive:
// committed`; the real status and receipt headers follow at the end of the
// body as `conifer_receipt`.

import type { HeaderReader } from "./receipt.ts";

/** Whether the gateway committed this response before its answer existed. */
export function isCommitted(headers: HeaderReader): boolean {
  return headers.get("x-conifer-keepalive")?.trim().toLowerCase() === "committed";
}

export interface Settled {
  /** The answer's real status. */
  status: number;
  /** The receipt headers the answer carried, over the response's own. */
  headers: HeaderReader;
  /** The body without `conifer_receipt`. */
  data: Record<string, unknown>;
}

/**
 * A committed body read back into the answer it carries. `undefined` when the
 * body has no well-formed `conifer_receipt`, which is appended last: the
 * delivery was cut before it finished.
 */
export function settleCommitted(data: unknown, headers: HeaderReader): Settled | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const { conifer_receipt: member, ...rest } = data as Record<string, unknown>;
  if (typeof member !== "object" || member === null) return undefined;
  const { status, headers: carried } = member as { status?: unknown; headers?: unknown };
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  const named = new Map<string, string>();
  if (typeof carried === "object" && carried !== null) {
    for (const [name, value] of Object.entries(carried)) {
      if (typeof value === "string") named.set(name.toLowerCase(), value);
    }
  }
  return {
    status,
    data: rest,
    headers: { get: (name) => named.get(name.toLowerCase()) ?? headers.get(name) },
  };
}
