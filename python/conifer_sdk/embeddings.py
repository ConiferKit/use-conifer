"""``POST /v1/embeddings``: body, headers, and vector decoding."""

from __future__ import annotations

import base64
import struct
from typing import Any, Dict, List

from .chat import cost_ceiling
from .types import EmbeddingsRequest


def embeddings_body(request: EmbeddingsRequest) -> Dict[str, Any]:
    """The JSON body. Vectors are requested as base64 float32 by default."""
    body: Dict[str, Any] = {
        "model": request.model,
        "input": request.input,
        "encoding_format": request.encoding_format or "base64",
    }
    if request.dimensions is not None:
        body["dimensions"] = request.dimensions
    if request.user is not None:
        body["user"] = request.user
    body.update(request.extra_body)
    return body


def embeddings_headers(request: EmbeddingsRequest, idempotency_key: str) -> Dict[str, str]:
    """The request headers for one embeddings call."""
    headers = dict(request.headers)
    headers["idempotency-key"] = idempotency_key
    if request.max_cost_nano_usd is not None:
        headers["x-conifer-max-cost-nanousd"] = cost_ceiling(request.max_cost_nano_usd)
    if request.request_id is not None:
        headers["x-request-id"] = request.request_id
    if request.client is not None:
        headers["x-conifer-client"] = request.client
    return headers


def decode_vector(value: Any) -> List[float]:
    """A vector as floats from either wire encoding. Base64 is little-endian
    float32. An unrecognised shape yields an empty vector rather than a guess."""
    if isinstance(value, (list, tuple)):
        return [float(x) for x in value]
    if not isinstance(value, str):
        return []
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        return []
    if not raw or len(raw) % 4 != 0:
        return []
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))
