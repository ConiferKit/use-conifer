// index.ts — the SDK's one public seam. Consumers import from here.

export {
  Conifer,
  Embeddings,
  JobsApi,
  KeysApi,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MIN_DEFER_WINDOW_SECONDS,
  MAX_SERVER_FALLBACK_MODELS,
} from "./client.ts";
export type { ConiferOptions } from "./client.ts";
export {
  chatBody,
  chatHeaders,
  decodeVector,
  embeddingsBody,
  embeddingsHeaders,
  pickCheapest,
  priceOf,
  resolveBaseUrl,
  resolveChain,
  routeBody,
  serverFallbackHeader,
  toCatalogModel,
  toDeferredJob,
  withCost,
  turnIdentity,
  parseFrame,
} from "./client.ts";

export {
  textOf,
  emptyReason,
  vectorOf,
  isTerminalJob,
  TERMINAL_JOB_STATUSES,
} from "./types.ts";
export type {
  Balance,
  CatalogModel,
  ChatRequest,
  Choice,
  Completion,
  CompletionStream,
  DeferredJob,
  Embedding,
  EmbeddingsRequest,
  EmbeddingsResponse,
  Message,
  JobStatus,
  Role,
  RouteDecision,
  RoutePolicy,
  RouteRequest,
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
  ConiferCapabilityError,
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

// Receipts for the client you ALREADY use: an injected fetch that reads the
// x-conifer-* disclosure every mainstream client throws away.
export { ReceiptCollector, SpendBudget } from "./receipts.ts";
export type { ObservedReceipt, ReceiptTotal } from "./receipts.ts";

export { STREAM_IDLE_MS, Transport, backoffMs, minimumBackoffMs } from "./transport.ts";
export type { FetchLike, RequestSpec, StreamLease, TransportOptions } from "./transport.ts";

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

// The installed version, so a bug report can name what it is running.
export { VERSION } from "./version.ts";
