// One error class per kind of gateway refusal. Branch on the class, not the
// status: a 402 alone does not say whether to add credit, raise a ceiling,
// or mint a new key.

export interface ConiferErrorInit {
  status: number;
  type: string;
  message: string;
  /** The OpenAI-compatible `error.code`, which distinguishes refusals that share a `type`. */
  code?: string;
  /** The request field the refusal is about, when it is field-scoped. */
  param?: string;
  requestId?: string;
  /** The raw envelope. */
  body?: unknown;
}

export class ConiferError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly body?: unknown;
  /** Whether re-sending the same bytes could succeed. Transport faults and 429/5xx only. */
  readonly retryable: boolean = false;

  constructor(init: ConiferErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.requestId = init.requestId;
    this.body = init.body;
  }
}

/** 401 or 403. */
export class ConiferAuthError extends ConiferError {}

/** 402: the account is out of credit. Add funds. */
export class ConiferPaymentError extends ConiferError {
  /** Worst-case cost of the refused request, in nanodollars. */
  readonly requiredNanoUsd?: number;
  /** What the billed account holds, in nanodollars. */
  readonly balanceNanoUsd?: number;
  constructor(init: ConiferErrorInit) {
    super(init);
    this.requiredNanoUsd = integerAfter(init.message, /needs up to (-?\d+) nanodollars/);
    this.balanceNanoUsd = structuredBalance(init.body) ?? integerAfter(init.message, /holds? (-?\d+)/);
  }
}

/** 402: your own `maxCostNanoUsd` refused this request. Raise it or send less. */
export class ConiferCostCeilingError extends ConiferError {
  readonly projectedNanoUsd?: number;
  readonly ceilingNanoUsd?: number;
  constructor(init: ConiferErrorInit) {
    super(init);
    const [projected, ceiling] = twoIntegers(init.message);
    this.projectedNanoUsd = projected;
    this.ceilingNanoUsd = ceiling;
  }
}

/** 402: this API key's lifetime spend cap is spent. Adding credit does nothing; raise the cap or mint a key. */
export class ConiferKeySpendCapError extends ConiferError {}

/** 400. */
export class ConiferBadRequestError extends ConiferError {}

/**
 * 400: this model cannot take this request's shape (images on a no-vision
 * model, tools on a no-tool model). The one 400 a different model fixes, so
 * the `chat()` fallback chain advances on it.
 */
export class ConiferCapabilityError extends ConiferBadRequestError {
  readonly modelSwitchable = true;
}

/** 404. The gateway does not distinguish "no such model" from "not in your catalog". */
export class ConiferModelNotFoundError extends ConiferError {}

/**
 * 409: an idempotency key that cannot be answered right now. Retryable when
 * the gateway says "retry shortly" (a first attempt is still in flight);
 * terminal when the key was reused with a different body.
 */
export class ConiferConflictError extends ConiferError {
  readonly retryable: boolean;
  constructor(init: ConiferErrorInit) {
    super(init);
    this.retryable = /retry shortly/i.test(init.message);
  }
}

/** The provider rejected your own key on the BYOK lane. */
export class ConiferByokKeyError extends ConiferError {}

/** 429. */
export class ConiferRateLimitError extends ConiferError {
  readonly retryable = true;
  /** From the `retry-after` header, when sent. */
  readonly retryAfterSeconds?: number;
  constructor(init: ConiferErrorInit & { retryAfterSeconds?: number }) {
    super(init);
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The upstream provider failed. A 502 may be retried; a 422 refused these bytes on their merits. */
export class ConiferUpstreamError extends ConiferError {
  readonly retryable: boolean;
  constructor(init: ConiferErrorInit) {
    super(init);
    this.retryable = init.status >= 500;
  }
}

/** 503. */
export class ConiferUnavailableError extends ConiferError {
  readonly retryable = true;
}

/** No verdict arrived in time. Whether the turn was billed is unknown. */
export class ConiferTimeoutError extends ConiferError {
  readonly retryable = true;
  constructor(message: string, requestId?: string) {
    super({ status: 0, type: "timeout", message, requestId });
  }
}

/** The socket failed. Whether the turn was billed is unknown. */
export class ConiferConnectionError extends ConiferError {
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super({ status: 0, type: "connection_error", message, body: cause });
  }
}

/**
 * A request carries something Conifer cannot honour. Thrown rather than
 * dropped, so a migration never silently changes what runs or what it costs.
 */
export class ConiferPortabilityError extends ConiferError {
  /** The field with no Conifer equivalent. */
  readonly field: string;
  constructor(field: string, message: string) {
    super({ status: 0, type: "unsupported_by_conifer", message });
    this.field = field;
  }
}

function integerAfter(message: string, pattern: RegExp): number | undefined {
  const found = message.match(pattern);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

function structuredBalance(body: unknown): number | undefined {
  const envelope = (body as { error?: { balance_nanodollars?: unknown } } | undefined)?.error;
  const value = envelope?.balance_nanodollars;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function twoIntegers(message: string): [number | undefined, number | undefined] {
  const found = message.match(/-?\d+/g);
  if (!found) return [undefined, undefined];
  const num = (i: number) => (found[i] === undefined ? undefined : Number(found[i]));
  return [num(0), num(1)];
}

function rateLimit(init: ConiferErrorInit, headers: { get(name: string): string | null }): ConiferRateLimitError {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return new ConiferRateLimitError({ ...init, retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined });
}

/**
 * Map a refusal onto its class. The gateway speaks the industry vocabulary,
 * where `invalid_request_error` covers 400, 401 and 404, so the discriminator
 * is `type`, then `code`, then status. The gateway's retired private type
 * names are still accepted. Unknown types stay a plain `ConiferError`.
 */
export function errorFrom(status: number, body: unknown, headers: { get(name: string): string | null }): ConiferError {
  const envelope =
    typeof body === "object" && body !== null && "error" in body
      ? ((body as { error: unknown }).error as Record<string, unknown>)
      : undefined;
  const type = typeof envelope?.type === "string" ? envelope.type : `http_${status}`;
  const code = typeof envelope?.code === "string" ? envelope.code : undefined;
  const param = typeof envelope?.param === "string" ? envelope.param : undefined;
  const message = typeof envelope?.message === "string" ? envelope.message : `the gateway refused with HTTP ${status}`;
  const requestId = headers.get("x-conifer-request-id") ?? headers.get("x-request-id") ?? undefined;
  const init: ConiferErrorInit = { status, type, code, param, message, requestId, body };

  if (type === "invalid_request_error") {
    if (code === "invalid_api_key" || status === 401 || status === 403) return new ConiferAuthError(init);
    if (code === "model_not_found" || status === 404) return new ConiferModelNotFoundError(init);
    if (code === "unsupported_parameter" || (code === "invalid_value" && param === "tools")) {
      return new ConiferCapabilityError(init);
    }
    return new ConiferBadRequestError(init);
  }
  if (type === "rate_limit_error") return rateLimit(init, headers);

  switch (type) {
    case "unauthorized":
      return new ConiferAuthError(init);
    case "insufficient_allowance":
      return new ConiferPaymentError(init);
    case "cost_ceiling_exceeded":
      return new ConiferCostCeilingError(init);
    case "key_spend_cap_exceeded":
      return new ConiferKeySpendCapError(init);
    case "invalid_request":
      return new ConiferBadRequestError(init);
    case "model_not_found":
    case "job_not_found":
    case "unknown_provider":
      return new ConiferModelNotFoundError(init);
    case "request_in_progress":
      return new ConiferConflictError(init);
    case "byok_key_rejected":
      return new ConiferByokKeyError(init);
    case "rate_limited":
      return rateLimit(init, headers);
    case "service_unavailable":
      return new ConiferUnavailableError(init);
    case "upstream_error":
    case "wire_upstream_mismatch":
      return new ConiferUpstreamError(init);
    default:
      return status >= 500 || status === 429 ? new ConiferUnavailableError(init) : new ConiferError(init);
  }
}
