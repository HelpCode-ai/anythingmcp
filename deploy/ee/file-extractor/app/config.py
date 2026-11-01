# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Settings read from the environment.

Everything except EXTRACT_CONCURRENCY is read per request, so a changed
environment (or a test's monkeypatch) takes effect without a restart.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

HARD_MAX_CHARS = 2_000_000


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    token: str
    max_input_bytes: int
    timeout_seconds: float
    large_timeout_seconds: float
    large_input_bytes: int
    queue_timeout_seconds: float
    child_memory_mb: int
    tmp_root: str


def load_settings() -> Settings:
    return Settings(
        token=os.environ.get("EXTRACTOR_TOKEN", ""),
        max_input_bytes=_int("MAX_INPUT_BYTES", 209_715_200),
        timeout_seconds=_float("TIMEOUT_SECONDS", 60.0),
        large_timeout_seconds=_float("LARGE_TIMEOUT_SECONDS", 300.0),
        large_input_bytes=_int("LARGE_INPUT_BYTES", 52_428_800),
        queue_timeout_seconds=_float("QUEUE_TIMEOUT_SECONDS", 30.0),
        child_memory_mb=_int("CHILD_MEMORY_MB", 1536),
        tmp_root=os.environ.get("EXTRACTOR_TMPDIR", "/tmp"),
    )


def extract_concurrency() -> int:
    return max(1, _int("EXTRACT_CONCURRENCY", 2))
