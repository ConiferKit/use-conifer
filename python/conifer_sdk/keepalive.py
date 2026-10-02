"""The response keepalive. A non-streaming answer still running after 285 s is
committed by the gateway as a provisional 200 with ``x-conifer-keepalive:
committed``; the real status and receipt headers follow at the end of the body
as ``conifer_receipt``."""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Tuple


def is_committed(headers: Mapping[str, str]) -> bool:
    """Whether the gateway committed this response before its answer existed."""
    value = next((v for k, v in headers.items() if k.lower() == "x-conifer-keepalive"), None)
    return value is not None and value.strip().lower() == "committed"


def settle_committed(
    data: Any, headers: Mapping[str, str]
) -> Optional[Tuple[int, Dict[str, str], Dict[str, Any]]]:
    """A committed body read back into the answer it carries: its real status,
    the receipt headers it carried over the response's own, and the body
    without ``conifer_receipt``. ``None`` when the body has no well-formed
    ``conifer_receipt``, which is appended last: the delivery was cut before
    it finished."""
    if not isinstance(data, dict):
        return None
    member = data.get("conifer_receipt")
    if not isinstance(member, dict):
        return None
    status = member.get("status")
    if not isinstance(status, int) or isinstance(status, bool):
        return None
    carried = member.get("headers")
    merged = {key.lower(): value for key, value in headers.items()}
    if isinstance(carried, dict):
        merged.update({k.lower(): v for k, v in carried.items() if isinstance(v, str)})
    rest = {key: value for key, value in data.items() if key != "conifer_receipt"}
    return status, merged, rest
