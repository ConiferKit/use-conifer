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
  /**
   * The OpenAI-compatible `error.code`, when the gateway sent one.
   *
   * This is not decoration: the gateway speaks the INDUSTRY vocabulary, in
   * which `type` collapses a 401 and a 400 into one `invalid_request_error`.
   * `code` is what separates them (`invalid_api_key`, `model_not_found`,
   * `context_length_exceeded`, `unsupported_parameter`, `unknown_url`, …), and
   * it is the field LangChain, LiteLLM and openai-python already branch on.
   */
  code?: string;
  requestId?: string;
  /** Raw envelope, so nothing the gateway said is lost behind our class names. */
  body?: unknown;
}

export class ConiferError extends Error {
  readonly status: number;
  readonly type: string;
  /** The OpenAI-compatible `error.code`. See {@link ConiferErrorInit.code}. */
  readonly code?: string;
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
    this.code = init.code;
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

/**
 * 402: this API KEY's own lifetime spend cap is exhausted.
 *
 * The THIRD distinct 402, and the reason branching on status is not enough.
 * The three have three different remedies and it matters which you got:
 *
 *   - `ConiferPaymentError`      — the ACCOUNT is out of credit. Add funds.
 *   - `ConiferCostCeilingError`  — YOUR per-request `maxCostNanoUsd` refused
 *                                  this turn. Raise it, or send less.
 *   - `ConiferKeySpendCapError`  — the KEY you are holding has spent its
 *                                  lifetime cap. The account may be fully
 *                                  funded and every other key still works;
 *                                  the fix is a new key or a raised cap, and
 *                                  adding credit does nothing at all.
 *
 * Nothing is charged for a refusal on any of the three.
 */
export class ConiferKeySpendCapError extends ConiferError {}

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

/** A 429 under either the industry name or the retired one, with its hint. */
function rateLimit(
  init: ConiferErrorInit,
  headers: { get(name: string): string | null },
): ConiferRateLimitError {
  const raw = headers.get("retry-after");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return new ConiferRateLimitError({
    ...init,
    retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined,
  });
}

/**
 * Map a gateway refusal onto its class. Unknown types stay a plain ConiferError.
 *
 * THE `invalid_request_error` COLLAPSE (measured live 2026-08-27). The gateway
 * deliberately speaks the INDUSTRY error vocabulary rather than a third schema
 * of its own: a 401 and a 400 both render `type: "invalid_request_error"`, and
 * a 429 renders `rate_limit_error`, because that is what OpenAI, Groq, Together,
 * Fireworks, DeepSeek and xAI all send and therefore what every existing client
 * already branches on.
 *
 * That collapse is good for portability and fatal for a switch on `type` alone.
 * An earlier version of this function switched on the gateway's older private
 * names (`unauthorized`, `invalid_request`, `rate_limited`), which the gateway
 * has since retired — so `ConiferAuthError`, `ConiferBadRequestError` and
 * `ConiferRateLimitError` were UNREACHABLE against the live gateway and every
 * 401 and 400 arrived as a bare `ConiferError`. Worse, a 429 fell to the
 * status-based default and lost its `retry-after`.
 *
 * So the discriminator is (type, code, status), in that order of authority:
 * `error.code` disambiguates the collapsed type where the gateway sends one
 * (`invalid_api_key` for the 401), and the STATUS settles it where it does not.
 * The retired names are still accepted so an older gateway deploy, or a
 * recorded fixture, keeps mapping to the same class.
 */
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
  const code = typeof envelope?.code === "string" ? envelope.code : undefined;
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : `the gateway refused with HTTP ${status}`;
  const requestId =
    headers.get("x-conifer-request-id") ?? headers.get("x-request-id") ?? undefined;
  const init: ConiferErrorInit = { status, type, code, message, requestId, body };

  // The industry-vocabulary types, resolved by code then status.
  if (type === "invalid_request_error") {
    if (code === "invalid_api_key" || status === 401 || status === 403) {
      return new ConiferAuthError(init);
    }
    if (code === "model_not_found" || status === 404) {
      return new ConiferModelNotFoundError(init);
    }
    return new ConiferBadRequestError(init);
  }
  if (type === "rate_limit_error") {
    return rateLimit(init, headers);
  }

  switch (type) {
    // Retired private name, kept so an older deploy maps identically.
    case "unauthorized":
      return new ConiferAuthError(init);
    case "insufficient_allowance":
      return new ConiferPaymentError(init);
    case "cost_ceiling_exceeded":
      return new ConiferCostCeilingError(init);
    case "key_spend_cap_exceeded":
      return new ConiferKeySpendCapError(init);
    // 404. A BYOK provider name the gateway does not serve — a caller-side
    // typo in the same family as a model that does not exist, so it shares
    // the class a caller already handles for "that name is not a thing here".
    case "unknown_provider":
      return new ConiferModelNotFoundError(init);
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
      // Retired private name; `rate_limit_error` is handled above.
      return rateLimit(init, headers);
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
