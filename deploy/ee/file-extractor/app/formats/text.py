# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Plain text (incl. configuration and source code), HTML and RTF."""

from __future__ import annotations

import re
from html.parser import HTMLParser

from ..errors import ExtractError
from ..job import Job
from ..textdecode import decode_bytes, read_capped

_PARAGRAPH_SPLIT = re.compile(r"\n[ \t]*\n")


def add_flow_text(job: Job, text: str) -> None:
    """Feed flowing text paragraph by paragraph into the segmenter."""
    for paragraph in _PARAGRAPH_SPLIT.split(text):
        if job.out.full:
            if paragraph.strip():
                job.out.mark_truncated()
            return
        job.out.add_block(paragraph)
        job.out.add_break()


def extract_plain(job: Job) -> None:
    """txt, md, json, xml, log: decoded as text, never parsed."""
    data, more = read_capped(job.path, job.max_chars)
    add_flow_text(job, decode_bytes(data))
    if more:
        job.out.mark_truncated()


_SNIFF_BYTES = 8192


def _utf16_without_bom(head: bytes) -> str | None:
    """``utf-16-le``/``-be`` if ``head`` looks like BOM-less UTF-16 text."""
    even, odd = head[0::2], head[1::2]

    def text_like(zeros: bytes, chars: bytes) -> bool:
        if len(zeros) < 16 or zeros.count(0) < 0.9 * len(zeros) or chars.count(0):
            return False
        ascii_text = sum(1 for b in chars if 0x20 <= b < 0x7F or b in (0x09, 0x0A, 0x0D))
        return ascii_text >= 0.9 * len(chars)

    if text_like(odd, even):
        return "utf-16-le"
    if text_like(even, odd):
        return "utf-16-be"
    return None


def extract_source(job: Job) -> None:
    """Configuration, data and source code files (yaml, ini, sql, py, ts,
    ...): decoded as text, never parsed or run.

    Some of these extensions are shared with binary formats (``.ts`` is also
    an MPEG transport stream video); a file with NUL bytes that is not
    UTF-16 is reported as unsupported instead of being indexed as noise.
    """
    data, more = read_capped(job.path, job.max_chars)
    head = data[:_SNIFF_BYTES]
    has_bom = head.startswith((b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff"))
    if b"\x00" in head and not has_bom:
        encoding = _utf16_without_bom(head[: len(head) - len(head) % 2])
        if encoding is None:
            raise ExtractError("unsupported", f"The .{job.ext} file is not a text file (it contains binary data).")
        text = data[: len(data) - len(data) % 2].decode(encoding, "replace")
    else:
        text = decode_bytes(data)
    add_flow_text(job, text)
    if more:
        job.out.mark_truncated()


# -- HTML -----------------------------------------------------------------------

_BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "table", "thead", "tbody", "tfoot",
    "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer",
    "blockquote", "pre", "hr", "dt", "dd", "dl", "form", "nav", "aside", "main",
    "figure", "figcaption", "address", "caption", "title", "body", "html",
}
_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "object", "iframe"}
_SPACES = re.compile(r"[ \t\r\f\v\u00a0]+")


class _HtmlText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.in_title = False
        self.title_parts: list[str] = []
        self.cells_in_row = 0
        self.pre_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self.skip_depth += 1
            return
        if tag == "title":
            self.in_title = True
            return
        if tag == "tr":
            self.cells_in_row = 0
        if tag in ("td", "th"):
            if self.cells_in_row:
                self.parts.append(" · ")
            self.cells_in_row += 1
        if tag == "pre":
            self.pre_depth += 1
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in ("br", "hr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if tag == "title":
            self.in_title = False
            return
        if tag == "pre" and self.pre_depth:
            self.pre_depth -= 1
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.in_title:
            self.title_parts.append(data)
            return
        if self.pre_depth:
            self.parts.append(data)
        else:
            self.parts.append(_SPACES.sub(" ", data.replace("\n", " ")))

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [line.strip() for line in raw.split("\n")]
        out: list[str] = []
        for line in lines:
            if line or (out and out[-1]):
                out.append(line)
        return "\n".join(out).strip()


def html_to_text(html: str) -> tuple[str, str | None]:
    parser = _HtmlText()
    for start in range(0, len(html), 1 << 20):
        parser.feed(html[start:start + (1 << 20)])
    parser.close()
    title = " ".join("".join(parser.title_parts).split()) or None
    return parser.text(), title


def extract_html(job: Job) -> None:
    data, more = read_capped(job.path, job.max_chars * 2)
    text, title = html_to_text(decode_bytes(data))
    if title:
        job.meta["title"] = title[:500]
    add_flow_text(job, text)
    if more:
        job.out.mark_truncated()


# -- RTF ------------------------------------------------------------------------

_ANSICPG = re.compile(rb"\\ansicpg(\d{3,5})")


def rtf_bytes_to_text(data: bytes) -> str:
    import codecs

    from striprtf.striprtf import rtf_to_text

    encoding = "cp1252"
    match = _ANSICPG.search(data[:4096])
    if match:
        candidate = "cp" + match.group(1).decode("ascii")
        try:
            codecs.lookup(candidate)
            encoding = candidate
        except LookupError:
            pass
    return rtf_to_text(data.decode("latin-1"), encoding=encoding, errors="replace")


def extract_rtf(job: Job) -> None:
    with open(job.path, "rb") as fh:
        data = fh.read()
    add_flow_text(job, rtf_bytes_to_text(data))
