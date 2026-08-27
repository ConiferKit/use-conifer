// index.ts — the SDK's one public seam. Consumers import from here.

export { Conifer, KeysApi, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./client.ts";
export type { ConiferOptions } from "./client.ts";
export {
  chatBody,
  chatHeaders,
  pickCheapest,
  priceOf,
  resolveBaseUrl,
  resolveChain,
  toCatalogModel,
  parseFrame,
} from "./client.ts";

export { textOf } from "./types.ts";
export type {
  Balance,
  CatalogModel,
  ChatRequest,
  Choice,
  Completion,
  CompletionStream,
  Message,
  Role,
  StreamChunk,
  Usage,
} from "./types.ts";

export {
  nanoUsdToUsdString,
  parseCostComponents,
  readReceipt,
} from "./receipt.ts";
export type { CostComponents, Receipt } from "./receipt.ts";

export {
  ConiferAuthError,
  ConiferBadRequestError,
  ConiferByokKeyError,
  ConiferConflictError,
  ConiferConnectionError,
  ConiferCostCeilingError,
  ConiferError,
  ConiferKeySpendCapError,
  ConiferModelNotFoundError,
  ConiferPaymentError,
  ConiferPortabilityError,
  ConiferRateLimitError,
  ConiferTimeoutError,
  ConiferUnavailableError,
  ConiferUpstreamError,
  errorFrom,
} from "./errors.ts";

export { Transport, backoffMs } from "./transport.ts";
export type { FetchLike, RequestSpec, TransportOptions } from "./transport.ts";

// Portability: migrate from another gateway without silently changing what runs.
export {
  fromOpenRouter,
  attributionFromOpenRouter,
} from "./portability/openrouter.ts";
export type { OpenRouterRequest, ShimOptions } from "./portability/openrouter.ts";
export {
  ceilingFromPolicy,
  fromHeliconeHeaders,
  parseFallbacks,
} from "./portability/helicone.ts";
export type { HeliconeHeaders } from "./portability/helicone.ts";
export {
  assertSupportedVercelSurface,
  coniferOpenAICompatibleConfig,
  fromVercelProviderOptions,
  vercelEnvMigration,
} from "./portability/vercel.ts";
export type { VercelProviderOptions } from "./portability/vercel.ts";
