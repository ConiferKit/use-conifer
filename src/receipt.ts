// The `x-conifer-*` receipt headers, parsed. A header the gateway omitted
// stays `undefined`: on a stream the head is sent before the cost settles, so
// the routing fields are present and the cost fields are not.

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
  /** The model that served. */
  effectiveModel?: string;
  /** `as_requested`, `routed`, or `provider_failover`. */
  reason?: string;
  /** The lane that served: credits, or your own key. */
  endpoint?: string;
  /** Settled cost in integer nanodollars ($1 = 1e9). */
  costNanoUsd?: number;
  /** The same cost as an exact decimal USD string. */
  costUsd?: string;
  /** Itemised cost. Absent when the gateway could not guarantee the sum. */
  costComponentsNanoUsd?: CostComponents;
  serviceTier?: string;
  /** The venue that served the turn. */
  receiptVenue?: string;
  /** What this turn would have cost at the default pin. Absent unless the turn was routed. */
  counterfactualNanoUsd?: number;
  /** Prompt-cache disclosure, when sent. */
  cache?: string;
  /** The id to quote in a support request. */
  requestId?: string;
}

export interface HeaderReader {
  get(name: string): string | null;
}

/** Nanodollars to an exact USD decimal string, with integer math. */
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

/** `fresh=<n>,cache_write=<n>,cache_read=<n>,output=<n>`. All four or nothing. */
export function parseCostComponents(raw: string | null): CostComponents | undefined {
  if (raw === null) return undefined;
  const seen: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [key, value] = pair.split("=");
    if (key === undefined || value === undefined) continue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) seen[key.trim()] = parsed;
  }
  const { fresh, cache_write: cacheWrite, cache_read: cacheRead, output } = seen;
  if (fresh === undefined || cacheWrite === undefined || cacheRead === undefined || output === undefined) {
    return undefined;
  }
  return { fresh, cacheWrite, cacheRead, output };
}

/** Every receipt header on one response. */
export function readReceipt(headers: HeaderReader): Receipt {
  const costNanoUsd = integer(headers, "x-conifer-cost-nanousd");
  return {
    requestedModel: text(headers, "x-conifer-requested-model"),
    effectiveModel: text(headers, "x-conifer-effective-model"),
    reason: text(headers, "x-conifer-receipt-reason"),
    endpoint: text(headers, "x-conifer-endpoint"),
    costNanoUsd,
    costUsd: costNanoUsd === undefined ? undefined : nanoUsdToUsdString(costNanoUsd),
    costComponentsNanoUsd: parseCostComponents(headers.get("x-conifer-cost-components-nanousd")),
    serviceTier: text(headers, "x-conifer-service-tier"),
    receiptVenue: text(headers, "x-conifer-receipt-venue"),
    counterfactualNanoUsd: integer(headers, "x-conifer-counterfactual-nanousd"),
    cache: text(headers, "x-conifer-cache"),
    requestId: text(headers, "x-conifer-request-id") ?? text(headers, "x-request-id"),
  };
}
