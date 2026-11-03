# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Decompression-bomb checks for ZIP-based formats (OOXML, ODF).

Only the ZIP directory is read: entry count first (from the end-of-central-
directory record, before the directory itself is parsed), then the declared
sizes of every entry.
"""

from __future__ import annotations

import zipfile

from .errors import ExtractError

MAX_ENTRIES = 10_000
MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024
MAX_RATIO = 200
# Tiny entries may legitimately compress very well; only judge the ratio of
# entries (and archives) that inflate to more than this.
RATIO_MIN_BYTES = 1024 * 1024

BOMB_MESSAGE = "The file looks like a decompression bomb and was not opened."


def check_zip(path: str, label: str) -> None:
    not_zip = ExtractError("corrupt", f"The file is not a valid {label} file (not a ZIP container).")
    try:
        with open(path, "rb") as fh:
            endrec = zipfile._EndRecData(fh)  # type: ignore[attr-defined]
    except OSError:
        raise not_zip from None
    if not endrec:
        raise not_zip
    try:
        declared_entries = int(endrec[zipfile._ECD_ENTRIES_TOTAL])  # type: ignore[attr-defined]
    except (IndexError, TypeError, ValueError):
        declared_entries = 0
    if declared_entries > MAX_ENTRIES:
        raise ExtractError("corrupt", BOMB_MESSAGE)

    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
    except (zipfile.BadZipFile, OSError, ValueError, EOFError):
        raise not_zip from None

    if len(infos) > MAX_ENTRIES:
        raise ExtractError("corrupt", BOMB_MESSAGE)
    total = 0
    compressed = 0
    for info in infos:
        total += info.file_size
        compressed += info.compress_size
        if info.file_size > RATIO_MIN_BYTES and info.file_size / max(info.compress_size, 1) > MAX_RATIO:
            raise ExtractError("corrupt", BOMB_MESSAGE)
    if total > MAX_TOTAL_UNCOMPRESSED:
        raise ExtractError("corrupt", BOMB_MESSAGE)
    if total > RATIO_MIN_BYTES and total / max(compressed, 1) > MAX_RATIO:
        raise ExtractError("corrupt", BOMB_MESSAGE)
