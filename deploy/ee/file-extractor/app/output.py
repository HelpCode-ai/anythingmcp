# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Collects extracted text, enforces the character cap and builds segments.

Two ways to add text:

* ``add_page(n, text)`` for formats with real units (PDF pages, slides,
  spreadsheet segments). One call becomes one item with ``page = n``.
* ``add_block(text)`` for flowing documents (docx, txt, mail, ...). Blocks
  are packed into ``page: null`` segments of at most ``SEGMENT_CHARS``
  characters, split on paragraph boundaries, then on line boundaries, and
  only as a last resort inside a line.
"""

from __future__ import annotations

import re

SEGMENT_CHARS = 4000
# Once a segment holds this much, the next paragraph boundary closes it.
SOFT_SEGMENT_CHARS = 3000

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f￾￿]")
_MANY_BLANK_LINES = re.compile(r"\n{3,}")
_TRAILING_SPACE = re.compile(r"[ \t]+\n")


def clean_text(text: str) -> str:
    """Normalise newlines, drop control characters and lone surrogates."""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL.sub("", text)
    # Lone surrogates (from broken UTF-16 sources) cannot be encoded as
    # UTF-8; replace them rather than failing the whole response.
    text = text.encode("utf-8", "replace").decode("utf-8")
    text = _TRAILING_SPACE.sub("\n", text)
    text = _MANY_BLANK_LINES.sub("\n\n", text)
    return text


def _split_long_line(line: str, limit: int) -> list[str]:
    """Split a single over-long line at whitespace, else hard."""
    pieces: list[str] = []
    while len(line) > limit:
        cut = line.rfind(" ", 0, limit)
        if cut < limit // 2:
            cut = limit
        pieces.append(line[:cut].rstrip())
        line = line[cut:].lstrip()
    if line:
        pieces.append(line)
    return pieces


class Output:
    def __init__(self, max_chars: int) -> None:
        self.max_chars = max(1, int(max_chars))
        self.pages: list[dict] = []
        self.total_chars = 0
        self.truncated = False
        self._seg_lines: list[str] = []
        self._seg_len = 0

    # -- character budget ------------------------------------------------
    @property
    def full(self) -> bool:
        return self.truncated or self.total_chars >= self.max_chars

    def mark_truncated(self) -> None:
        self.truncated = True

    def _take(self, text: str) -> str | None:
        remaining = self.max_chars - self.total_chars
        if remaining <= 0:
            if text:
                self.truncated = True
            return None
        if len(text) > remaining:
            text = text[:remaining]
            self.truncated = True
        self.total_chars += len(text)
        return text

    # -- paged formats ---------------------------------------------------
    def add_page(self, page: int, text: str) -> None:
        """Add one numbered unit. Empty units are dropped (numbers stay real)."""
        text = clean_text(text).strip()
        if not text:
            return
        taken = self._take(text)
        if taken:
            self.pages.append({"page": int(page), "text": taken})

    # -- flowing formats -------------------------------------------------
    def add_block(self, text: str) -> None:
        """Add a paragraph-like block of flowing text."""
        text = clean_text(text).strip("\n")
        if not text.strip():
            return
        taken = self._take(text)
        if not taken:
            return
        for line in taken.split("\n"):
            self._add_line(line)
        # A block boundary is a paragraph boundary: a good place to cut.
        if self._seg_len >= SOFT_SEGMENT_CHARS:
            self._flush()

    def add_break(self) -> None:
        """Keep a blank line between the previous and the next block."""
        if self._seg_lines and self._seg_lines[-1] != "":
            self._seg_lines.append("")
            self._seg_len += 1

    def _add_line(self, line: str) -> None:
        if len(line) > SEGMENT_CHARS:
            for piece in _split_long_line(line, SEGMENT_CHARS):
                self._add_line(piece)
            return
        if not line.strip():
            if self._seg_len >= SOFT_SEGMENT_CHARS:
                self._flush()
                return
            if not self._seg_lines or not self._seg_lines[-1]:
                return  # no leading or doubled blank lines
            line = ""
        if self._seg_lines and self._seg_len + 1 + len(line) > SEGMENT_CHARS:
            self._flush()
            if not line:
                return
        self._seg_lines.append(line)
        self._seg_len += len(line) + (1 if self._seg_len else 0)

    def _flush(self) -> None:
        if self._seg_lines:
            text = "\n".join(self._seg_lines).strip("\n")
            if text.strip():
                self.pages.append({"page": None, "text": text})
        self._seg_lines = []
        self._seg_len = 0

    def finish(self) -> None:
        self._flush()

    def all_text(self) -> str:
        self.finish()
        return "\n\n".join(p["text"] for p in self.pages)
