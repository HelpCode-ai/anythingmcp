# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Turn bytes of unknown encoding into text."""

from __future__ import annotations

import codecs

_BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32-le"),
    (codecs.BOM_UTF32_BE, "utf-32-be"),
    (codecs.BOM_UTF8, "utf-8"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)

# charset-normalizer only looks at this much; the guess is applied to all.
_SAMPLE_BYTES = 256 * 1024


def decode_bytes(data: bytes) -> str:
    if not data:
        return ""
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            return data[len(bom):].decode(encoding, "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        # A cap may cut the last multi-byte character in half.
        if exc.start >= len(data) - 4 and exc.reason in ("unexpected end of data", "invalid continuation byte"):
            try:
                return data[: exc.start].decode("utf-8")
            except UnicodeDecodeError:
                pass
    encoding = "cp1252"
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(data[:_SAMPLE_BYTES]).best()
        if best is not None and best.encoding:
            encoding = best.encoding
    except Exception:  # detection is best effort
        pass
    try:
        return data.decode(encoding, "replace")
    except LookupError:
        return data.decode("cp1252", "replace")


def read_capped(path: str, max_chars: int) -> tuple[bytes, bool]:
    """Read at most enough bytes for ``max_chars`` characters.

    Returns the bytes and whether the file was longer than what was read.
    """
    limit = max_chars * 4 + 4
    with open(path, "rb") as fh:
        data = fh.read(limit)
        more = bool(fh.read(1))
    return data, more
