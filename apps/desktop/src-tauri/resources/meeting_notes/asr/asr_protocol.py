"""Minimal stdio protocol shared by real and mock ASR workers."""

from __future__ import annotations

import json
import os
import struct
import sys
from typing import Any, BinaryIO


def emit(event_type: str, **payload: Any) -> None:
    try:
        print(
            json.dumps(
                {"type": event_type, **payload},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            flush=True,
        )
    except BrokenPipeError:
        os._exit(0)


def read_exact(size: int, source: BinaryIO | None = None) -> bytes | None:
    source = source or sys.stdin.buffer
    data = bytearray()
    while len(data) < size:
        chunk = source.read(size - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def read_frame(source: BinaryIO | None = None) -> tuple[int, bytes] | None:
    kind = read_exact(1, source)
    if not kind:
        return None
    size_raw = read_exact(4, source)
    if not size_raw:
        return None
    size = struct.unpack("<I", size_raw)[0]
    payload = read_exact(size, source) if size else b""
    if payload is None:
        return None
    return kind[0], payload
