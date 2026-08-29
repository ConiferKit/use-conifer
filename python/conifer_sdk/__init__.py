"""The Conifer gateway SDK for Python.

Same cards as the TypeScript SDK (``sdk/cards/``), same laws:

* the receipt is parsed absence-preserving — a header the gateway omitted stays
  ``None``, because zero-filling turns "we do not know" into a wrong number;
* retries are narrow (transport faults and 429/502/503/504 only) and always
  carry one idempotency key, so a retry cannot double-bill;
* a portability input Conifer cannot honor raises rather than being dropped.

Standard library only, so ``pip install`` pulls no tree and the SDK works in a
lambda, a Slack bot, or a locked-down build image unchanged.
"""

__version__ = "0.1.2"

from .client import (
    Conifer,
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_SECONDS,
    MIN_DEFER_WINDOW_SECONDS,
    decode_vector,
    to_deferred_job,
    with_cost,
    turn_identity,
    parse_frame,
    resolve_base_url,
)
from .errors import (
    ConiferAuthError,
    ConiferBadRequestError,
    ConiferCapabilityError,
    ConiferByokKeyError,
    ConiferConflictError,
    ConiferConnectionError,
    ConiferCostCeilingError,
    ConiferKeySpendCapError,
    ConiferError,
    ConiferModelNotFoundError,
    ConiferPaymentError,
    ConiferPortabilityError,
    ConiferRateLimitError,
    ConiferTimeoutError,
    ConiferUnavailableError,
    ConiferUpstreamError,
    error_from,
)
from .receipt import CostComponents, Receipt, nano_usd_to_usd_string, read_receipt
from .portability import (
    attribution_from_openrouter,
    ceiling_from_policy,
    conifer_openai_compatible_config,
    from_helicone_headers,
    from_openrouter,
    from_vercel_provider_options,
    parse_fallbacks,
)
from .receipts import (
    ObservedReceipt,
    ReceiptCollector,
    ReceiptTotal,
    SpendBudget,
    SpendBudgetExceeded,
)
from .types import (
    Balance,
    DeferredJob,
    TERMINAL_JOB_STATUSES,
    is_terminal_job,
    CatalogModel,
    ChatRequest,
    Completion,
    Embedding,
    EmbeddingsRequest,
    EmbeddingsResponse,
    vector_of,
)

__all__ = [
    "Conifer",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT_SECONDS",
    "resolve_base_url",
    "parse_frame",
    "decode_vector",
    "ReceiptCollector",
    "ObservedReceipt",
    "ReceiptTotal",
    "SpendBudget",
    "SpendBudgetExceeded",
    "MIN_DEFER_WINDOW_SECONDS",
    "DeferredJob",
    "TERMINAL_JOB_STATUSES",
    "is_terminal_job",
    "to_deferred_job",
    "with_cost",
    "turn_identity",
    "Embedding",
    "EmbeddingsRequest",
    "EmbeddingsResponse",
    "vector_of",
    "ConiferError",
    "ConiferAuthError",
    "ConiferPaymentError",
    "ConiferCostCeilingError",
    "ConiferKeySpendCapError",
    "ConiferBadRequestError",
    "ConiferCapabilityError",
    "ConiferModelNotFoundError",
    "ConiferConflictError",
    "ConiferByokKeyError",
    "ConiferRateLimitError",
    "ConiferUpstreamError",
    "ConiferUnavailableError",
    "ConiferTimeoutError",
    "ConiferConnectionError",
    "ConiferPortabilityError",
    "error_from",
    "Receipt",
    "CostComponents",
    "read_receipt",
    "nano_usd_to_usd_string",
    "ChatRequest",
    "Completion",
    "CatalogModel",
    "Balance",
    "from_openrouter",
    "attribution_from_openrouter",
    "from_helicone_headers",
    "from_vercel_provider_options",
    "conifer_openai_compatible_config",
    "ceiling_from_policy",
    "parse_fallbacks",
]

