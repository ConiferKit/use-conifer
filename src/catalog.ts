// Reading the catalog: models, prices, and the cheapest model that declares
// what a caller needs.

import type { CatalogModel } from "./types.ts";

/** A catalog entry from `GET /v1/models`. `raw` keeps every field. */
export function toCatalogModel(entry: Record<string, unknown>): CatalogModel {
  return {
    id: String(entry.id ?? ""),
    endpointKind: entry.endpoint_kind as string | undefined,
    displayName: entry.display_name as string | undefined,
    provider: entry.provider as string | undefined,
    contextWindow: entry.context_window as number | undefined,
    maxOutputTokens: entry.max_output_tokens as number | undefined,
    minOutputTokens: entry.min_output_tokens as number | undefined,
    outputTokenLimitSupported: entry.output_token_limit_supported as boolean | undefined,
    maxTools: entry.max_tools as number | undefined,
    caps: entry.caps as string[] | undefined,
    embeddingDimensions: entry.embedding_dimensions as number | undefined,
    pricing: entry.pricing as CatalogModel["pricing"],
    feePct: entry.fee_pct as number | undefined,
    unavailable: entry.unavailable as boolean | undefined,
    raw: entry,
  };
}

/**
 * The cheapest model that declares every capability in `caps`. A model with
 * no declared caps, no price, or explicit inability to honor output limits is skipped.
 */
export function pickCheapest(
  models: CatalogModel[],
  caps: string[],
  options: { minContextWindow?: number } = {},
): CatalogModel | undefined {
  const eligible = models.filter((model) => {
    if (model.unavailable === true) return false;
    if (model.outputTokenLimitSupported === false) return false;
    if (options.minContextWindow !== undefined) {
      if (model.contextWindow === undefined || model.contextWindow < options.minContextWindow) return false;
    }
    if (caps.length === 0) return true;
    if (model.caps === undefined) return false;
    return caps.every((cap) => model.caps?.includes(cap));
  });
  const priced = eligible.filter((model) => priceOf(model) !== undefined);
  priced.sort((a, b) => (priceOf(a) as number) - (priceOf(b) as number));
  return priced[0];
}

/**
 * One comparable price per model: input plus three times output, in USD per
 * million tokens. A ranking key, not a cost forecast. Catalog prices are
 * decimal strings; an unrecognised pricing shape is unpriced, not free.
 */
export function priceOf(model: CatalogModel): number | undefined {
  const pricing = model.pricing;
  if (pricing === undefined) return undefined;
  const input = decimal(pricing.in_usd_per_mtok);
  const output = decimal(pricing.out_usd_per_mtok);
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + 3 * (output ?? 0);
}

function decimal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
