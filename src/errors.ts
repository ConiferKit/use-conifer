// errors.ts — one class per gateway `error.type`.
//
// The gateway authors a typed envelope (`{error: {type, message, ...}}`) for
// every refusal it owns. Branching on a NAME rather than a status number is the
// difference between "402" (two very different remedies) and
// `ConiferPaymentError` vs `ConiferCostCeilingError`. See cards/sdk.output.card.json.

/** Fields every Conifer error carries. */
export interface ConiferErrorInit {
  status: number;
  type: string;
  message: string;
  requestId?: string;
  /** Raw envelope, so nothing the gateway said is lost behind our class names. */
  body?: unknown;
}

export class ConiferError extends Error {
  readonly status: number;
  readonly type: string;
  readonly requestId?: string;
  readonly body?: unknown;
  /**
   * Whether re-sending the SAME bytes could plausibly succeed. Only transport
   * faults and 429/502/503/504 are retryable: a 4xx the gateway authored will
   * refuse the same bytes again, and retrying it is pure latency and burnt
   * rate limit (the gateway's own doc for its 422 mapping says exactly this).
   */
  readonly retryable: boolean = false;

  constructor(init: ConiferErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.status = init.status;
    this.type = init.type;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

export class ConiferAuthError extends ConiferError {}

export class ConiferPaymentError extends ConiferError {
  /** Nanodollars this request could have cost, worst case. */
  readonly requiredNanoUsd?: number;
  /** Nanodollars the billed account holds. */
  readonly balanceNanoUsd?: number;
  constructor(init: ConiferErrorInit) {
    super(init);
    const [required, balance] = twoIntegers(init.message);
    this.requiredNanoUsd = required;
    this.balanceNanoUsd = balance;
  }
}

export class ConiferCostCeilingError extends ConiferError {
  /** The worst case the gateway projected, in nanodollars. */
  readonly projectedNanoUsd?: number;
  /** The ceiling you set via `maxCostNanoUsd`. */
  readonly ceilingNanoUsd?: number;
  constructor(init: ConiferErrorInit) {
    super(init);
    const [projected, ceiling] = twoIntegers(init.message);
    this.projectedNanoUsd = projected;
    this.ceilingNanoUsd = ceiling;
  }
}

export class ConiferBadRequestError extends ConiferError {}
/**
 * 404. NOTE: the gateway deliberately cannot distinguish "no such model" from
 * "a model you may not see" — both are absent from your catalog listing and
 * both render this same refusal. Do not treat it as proof of non-existence.
 */
export class ConiferModelNotFoundError extends ConiferError {}
export class ConiferConflictError extends ConiferError {}
export class ConiferByokKeyError extends ConiferError {}

export class ConiferRateLimitError extends ConiferError {
  readonly retryable = true;
  /** From `retry-after`, when the gateway sent one. */
  readonly retryAfterSeconds?: number;
  constructor(init: ConiferErrorInit & { retryAfterSeconds?: number }) {
    super(init);
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export class ConiferUpstreamError extends ConiferError {
  /**
   * A 502 is a transport-shaped upstream failure and may be retried. A 422 is
   * the gateway telling you the upstream refused these bytes on their merits —
   * retrying is the exact waste the mapping exists to prevent.
   */
  readonly retryable: boolean;
  constructor(init: ConiferErrorInit) {
    super(init);
    this.retryable = init.status >= 500;
  }
}

export class ConiferUnavailableError extends ConiferError {
  readonly retryable = true;
}

/** No verdict arrived. We make no claim about whether the turn was billed. */
export class ConiferTimeoutError extends ConiferError {
  readonly retryable = true;
  constructor(message: string, requestId?: string) {
    super({ status: 0, type: "timeout", message, requestId });
  }
}

/** The socket failed. Same "no verdict" caveat as the timeout. */
export class ConiferConnectionError extends ConiferError {
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super({ status: 0, type: "connection_error", message, body: cause });
  }
}

/**
 * A portability shim was handed an input Conifer cannot honor.
 *
 * This is thrown, never swallowed, on purpose: dropping a spend ceiling, a
 * provider restriction, or a moderation flag would make a migration LOOK
 * successful while quietly changing what runs and what it costs. See
 * cards/portability.card.json ("never silently drop a constraint").
 */
export class ConiferPortabilityError extends ConiferError {
  /** The foreign field that has no Conifer equivalent. */
  readonly field: string;
  constructor(field: string, message: string) {
    super({ status: 0, type: "unsupported_by_conifer", message });
    this.field = field;
  }
}

/** The first two integers in a gateway money message, in order. */
function twoIntegers(message: string): [number | undefined, number | undefined] {
  const found = message.match(/-?\d+/g);
  if (!found) return [undefined, undefined];
  const num = (i: number) => (found[i] === undefined ? undefined : Number(found[i]));
  return [num(0), num(1)];
}

/** Map a gateway refusal onto its class. Unknown types stay a plain ConiferError. */
export function errorFrom(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
): ConiferError {
  const envelope =
    typeof body === "object" && body !== null && "error" in body
      ? ((body as { error: unknown }).error as Record<string, unknown>)
      : undefined;
  const type = typeof envelope?.type === "string" ? envelope.type : `http_${status}`;
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : `the gateway refused with HTTP ${status}`;
  const requestId =
    headers.get("x-conifer-request-id") ?? headers.get("x-request-id") ?? undefined;
  const init: ConiferErrorInit = { status, type, message, requestId, body };

  switch (type) {
    case "unauthorized":
      return new ConiferAuthError(init);
    case "insufficient_allowance":
      return new ConiferPaymentError(init);
    case "cost_ceiling_exceeded":
      return new ConiferCostCeilingError(init);
    case "invalid_request":
      return new ConiferBadRequestError(init);
    case "model_not_found":
    case "job_not_found":
      return new ConiferModelNotFoundError(init);
    case "request_in_progress":
      return new ConiferConflictError(init);
    case "byok_key_rejected":
      return new ConiferByokKeyError(init);
    case "rate_limited": {
      const raw = headers.get("retry-after");
      const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      return new ConiferRateLimitError({
        ...init,
        retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined,
      });
    }
    case "service_unavailable":
      return new ConiferUnavailableError(init);
    case "upstream_error":
    case "wire_upstream_mismatch":
      return new ConiferUpstreamError(init);
    default:
      // Unknown code: fall back to the STATUS for retryability only, and keep
      // the gateway's own type string intact so a new code is still readable.
      return status >= 500 || status === 429
        ? new ConiferUnavailableError(init)
        : new ConiferError(init);
  }
}
