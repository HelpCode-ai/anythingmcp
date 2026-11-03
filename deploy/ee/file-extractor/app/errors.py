# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Document-level errors reported as ``{"ok": false, "error": {...}}``."""

from __future__ import annotations

ERROR_KINDS = ("unsupported", "encrypted", "corrupt", "timeout", "too_large", "empty",
               # POST /render only
               "page_out_of_range", "damaged")


class ExtractError(Exception):
    """A document problem with a stable ``kind`` and a plain-English message.

    The message must never contain document content: it is returned to the
    caller and may end up in logs or UIs.
    """

    def __init__(self, kind: str, message: str) -> None:
        if kind not in ERROR_KINDS:
            raise ValueError(f"unknown error kind {kind!r}")
        super().__init__(message)
        self.kind = kind
        self.message = message


def empty_meta(fmt: str | None) -> dict:
    return {
        "title": None,
        "author": None,
        "pageCount": None,
        "sheetCount": None,
        "format": fmt,
    }


def error_result(kind: str, message: str, meta: dict | None = None, *,
                 ocr_pages: int = 0, empty_pages: int = 0) -> dict:
    return {
        "ok": False,
        "pages": [],
        "meta": meta if meta is not None else empty_meta(None),
        "truncated": False,
        "ocrPages": ocr_pages,
        "emptyPages": empty_pages,
        "error": {"kind": kind, "message": message},
    }
