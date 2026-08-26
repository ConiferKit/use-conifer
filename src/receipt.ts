// receipt.ts — the x-conifer-* disclosure headers, parsed.
//
// This is the field where Conifer differs from every gateway you might be
// migrating from: the EXACT integer cost of the turn, itemized, arrives on the
// same response as the completion. No second stats call, no float dollars.
//
// STREAMING CAVEAT (measured live 2026-08-26): on an SSE turn the response
// HEAD is sent before the completion settles, so the routing receipt is present
// but the COST headers are not — the money is known only after the last token.
// The SDK reports that honestly (`costNanoUsd` stays undefined) rather than
// inventing a number; read the terminal `usage` chunk to reconcile a stream.
//
// The parsing law here is absence-preserving: a header the gateway omitted
// stays `undefined`. The gateway omits `x-conifer-cost-components-nanousd`
// rather than approximate it, and omits `x-conifer-service-tier` when no
// completion window was declared. Zero-filling either would turn "we do not
// know" into a confident wrong number.

/** The four billed token classes, in nanodollars. They sum to `costNanoUsd`. */
export interface CostComponents {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface Receipt {
  /** The model id you sent. */
  requestedModel?: string;
  /** The catalog spelling actually served. Differs only by re-spelling, never by substitution. */
  effectiveModel?: string;
  /** The gateway's own word for why this route was taken. */
  reason?: string;
  /** Which lane served it: the credits lane or your own key. */
  endpoint?: string;
  /** Settled cost in nanodollars ($1 = 1e9). Integer. */
  costNanoUsd?: number;
  /** The same number as an exact decimal USD string, for display and ledgers. */
  costUsd?: string;
  /** Itemized cost. Absent when the gateway could not guarantee the sum identity. */
  costComponentsNanoUsd?: CostComponents;
  /** `flex` only ever from the provider's own echo; absent when no window was declared. */
  serviceTier?: string;
  /** The venue that SERVED the turn. This gateway is always `cloud`. */
  receiptVenue?: string;
  /**
   * The retail counterfactual at the documented default pin — what this turn
   * would have cost unrouted. OMITTED unless the routed predicate holds; never
   * a 0-as-guess, so absence means "not applicable", not "no saving".
   */
  counterfactualNanoUsd?: number;
  /** Prompt-cache disclosure, when the gateway sent one. */
  cache?: string;
  /** The id to quote in a support request. */
  requestId?: string;
}

/** Minimal shape we need from a fetch Response's headers. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Nanodollars -> an exact USD decimal string. Integer math only, no float. */
export function nanoUsdToUsdString(nano: number): string {
  const negative = nano < 0;
  const abs = Math.abs(nano);
  const whole = Math.floor(abs / 1_000_000_000);
  const frac = String(abs % 1_000_000_000).padStart(9, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function integer(headers: HeaderReader, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(headers: HeaderReader, name: string): string | undefined {
  const raw = headers.get(name);
  return raw === null ? undefined : raw;
}

/**
 * `fresh=<n>,cache_write=<n>,cache_read=<n>,output=<n>` -> the struct.
 *
 * Returns `undefined` unless ALL FOUR classes parsed: a partial itemization
 * whose parts do not sum to the total is worse than none, and the header's
 * whole contract is that the four sum to `x-conifer-cost-nanousd`.
 */
export function parseCostComponents(raw: string | null): CostComponents | undefined {
  if (raw === null) return undefined;
  const seen: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [key, value] = pair.split("=");
    if (key === undefined || value === undefined) continue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed)) continue;
    seen[key.trim()] = parsed;
  }
  const { fresh, cache_write: cacheWrite, cache_read: cacheRead, output } = seen;
  if (
    fresh === undefined ||
    cacheWrite === undefined ||
    cacheRead === undefined ||
    output === undefined
  ) {
    return undefined;
  }
  return { fresh, cacheWrite, cacheRead, output };
}

/** Read every receipt header off one response. */
export function readReceipt(headers: HeaderReader): Receipt {
  const costNanoUsd = integer(headers, "x-conifer-cost-nanousd");
  return {
    requestedModel: text(headers, "x-conifer-requested-model"),
    effectiveModel: text(headers, "x-conifer-effective-model"),
    reason: text(headers, "x-conifer-receipt-reason"),
    endpoint: text(headers, "x-conifer-endpoint"),
    costNanoUsd,
    costUsd: costNanoUsd === undefined ? undefined : nanoUsdToUsdString(costNanoUsd),
    costComponentsNanoUsd: parseCostComponents(
      headers.get("x-conifer-cost-components-nanousd"),
    ),
    serviceTier: text(headers, "x-conifer-service-tier"),
    receiptVenue: text(headers, "x-conifer-receipt-venue"),
    counterfactualNanoUsd: integer(headers, "x-conifer-counterfactual-nanousd"),
    cache: text(headers, "x-conifer-cache"),
    requestId:
      text(headers, "x-conifer-request-id") ?? text(headers, "x-request-id"),
  };
}
