"""The one place the SDK touches the network: ``urllib`` behind an injectable
``Transport`` callable, so tests drive real request bytes without a network."""

from __future__ import annotations

import json
import random
import ssl
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from . import __version__

#: (status, lower-cased headers, body text)
TransportResult = Tuple[int, Dict[str, str], str]
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], TransportResult]

#: Python's default User-Agent is on Cloudflare's browser-signature ban list.
USER_AGENT = f"conifer-sdk-python/{__version__}"

#: Statuses a retry can fix. 409 only counts when the error itself is retryable.
RETRYABLE_STATUS = {409, 429, 502, 503, 504}


def ssl_context() -> Optional["ssl.SSLContext"]:
    """The system trust store, or certifi's bundle when the system store is empty
    (a python.org install whose ``Install Certificates.command`` was never run)."""
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) > 0:
        return context
    try:
        import certifi
    except ImportError:
        return context
    return ssl.create_default_context(cafile=certifi.where())


def urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> TransportResult:
    """The default transport. An HTTP error status is a result, not an exception."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl_context()) as response:
            return (
                response.status,
                {key.lower(): value for key, value in response.headers.items()},
                response.read().decode("utf-8"),
            )
    except urllib.error.HTTPError as error:
        return (
            error.code,
            {key.lower(): value for key, value in (error.headers or {}).items()},
            error.read().decode("utf-8"),
        )


def with_user_agent(*header_maps: Mapping[str, str]) -> Dict[str, str]:
    """Merge header maps, adding the SDK User-Agent unless one is present under any casing."""
    merged: Dict[str, str] = {}
    for headers in header_maps:
        merged.update(headers)
    if not any(key.lower() == "user-agent" for key in merged):
        merged["user-agent"] = USER_AGENT
    return merged


def is_cert_failure(cause: BaseException) -> bool:
    return isinstance(cause, ssl.SSLCertVerificationError) or isinstance(
        getattr(cause, "reason", None), ssl.SSLCertVerificationError
    )


def parse_json(text: str, status: int) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": {"type": f"http_{status}", "message": text[:500]}}


def backoff_seconds(attempt: int) -> float:
    """Exponential backoff with jitter: 0.25 s, 0.5 s, 1 s, ..."""
    return 0.25 * (2**attempt) + random.random() * 0.1


def minimum_backoff_seconds(status: int) -> float:
    """A transient 409 waits on cross-replica convergence, not a socket, so it gets a longer floor."""
    return 1.5 if status == 409 else 0.0
