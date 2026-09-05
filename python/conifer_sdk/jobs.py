"""Deferred job envelopes and streaming frames."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, Iterator, Literal, Mapping, Optional, Union

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
    """One SSE frame to one chunk. ``[DONE]``, comments and invalid chunks yield ``None``."""
    chunk = decode_frame(frame)
    return chunk if isinstance(chunk, dict) else None


def decode_frame(frame: str) -> Union[Dict[str, Any], Literal["[DONE]"], None]:
    """Keep the terminator distinct from an ignored frame inside the iterator."""
    data = "\n".join(
        line[5:].removesuffix("\r").removeprefix(" ")
        for line in frame.split("\n") if line.startswith("data:")
    ).strip()
    if data == "[DONE]":
        return "[DONE]"
    if data == "":
        return None
    try:
        chunk = json.loads(data)
        return chunk if isinstance(chunk, dict) else None
    except json.JSONDecodeError:
        return None


def iter_frames(lines: Iterable[bytes]) -> Iterator[str]:
    """Group HTTP response lines into SSE events, retaining the existing EOF tail behavior."""
    buffered = []
    for line in lines:
        if line.rstrip(b"\r\n") == b"":
            yield "".join(buffered)
            buffered.clear()
        else:
            buffered.append(line.decode("utf-8"))
    if buffered:
        yield "".join(buffered)
