"""Deferred job envelopes and streaming frames."""

from __future__ import annotations

import json
from typing import Any, Dict, Mapping, Optional

from .types import DeferredJob


def to_deferred_job(payload: Mapping[str, Any]) -> DeferredJob:
    """The 202 and status envelope."""
    return DeferredJob(
        job_id=str(payload.get("job_id", "")),
        status=str(payload.get("status", "")),
        deadline_utc=payload.get("deadline_utc"),
        created_utc=payload.get("created_utc"),
        model=payload.get("model"),
        poll_url=payload.get("poll_url"),
        raw=dict(payload),
    )


def parse_frame(frame: str) -> Optional[Dict[str, Any]]:
    """One SSE line to one chunk. ``[DONE]``, comments and blanks yield ``None``."""
    line = frame.strip()
    if not line.startswith("data:"):
        return None
    data = line[5:].strip()
    if data == "" or data == "[DONE]":
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None
