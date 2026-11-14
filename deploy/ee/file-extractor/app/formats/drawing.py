# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Drawings: SVG (visible text only) and ASCII DXF (CAD text entities)."""

from __future__ import annotations

import re

from ..errors import ExtractError
from ..job import Job

# -- SVG --------------------------------------------------------------------------

# Elements whose text is read; everything else (paths, styles, scripts,
# metadata) is skipped. Inkscape's flowed text uses the flow* elements.
_SVG_TEXT = {"text", "title", "desc", "flowRoot"}
_SVG_LINE_ATTRS = ("y", "dy")
_WS = re.compile(r"[ \t\r\f\v\u00a0]+")


def _local(tag) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def _svg_element_text(element) -> str:
    """Text of a <text>/<title>/<desc>/<flowRoot>, tspans with their own
    line position on new lines."""
    parts: list[str] = []

    def walk(node, top: bool) -> None:
        name = _local(node.tag)
        if not top and (name == "flowPara" or (name == "tspan" and any(node.get(a) for a in _SVG_LINE_ATTRS))):
            if parts and not parts[-1].endswith("\n"):
                parts.append("\n")
        if node.text:
            parts.append(node.text)
        for child in node:
            if _local(child.tag) in ("style", "script", "flowRegion"):
                pass
            else:
                walk(child, False)
            if child.tail:
                parts.append(child.tail)

    walk(element, True)
    lines = (_WS.sub(" ", line).strip() for line in "".join(parts).split("\n"))
    return "\n".join(line for line in lines if line)


def extract_svg(job: Job) -> None:
    """Text of <text>, <tspan>, <title> and <desc>.

    Parsed with ``defusedxml``: external entities and external DTDs are
    refused (never fetched or read). Internal entities are allowed because
    Adobe Illustrator declares its namespaces as entities; Python's expat
    stops entity amplification ("billion laughs") on its own.
    """
    from defusedxml import DefusedXmlException
    from defusedxml.ElementTree import iterparse

    stack: list = []
    depth_in_text = 0
    try:
        with open(job.path, "rb") as fh:
            for event, element in iterparse(fh, events=("start", "end"), forbid_dtd=False,
                                            forbid_entities=False, forbid_external=True):
                name = _local(element.tag)
                if event == "start":
                    stack.append(element)
                    if name in _SVG_TEXT:
                        depth_in_text += 1
                    continue
                stack.pop()
                if name in _SVG_TEXT:
                    depth_in_text -= 1
                    if depth_in_text == 0:
                        if job.out.full:
                            job.out.mark_truncated()
                            break
                        text = _svg_element_text(element)
                        if name == "title" and len(stack) == 1 and not job.meta.get("title") and text:
                            job.meta["title"] = text[:500]
                        job.out.add_block(text)
                if depth_in_text == 0:
                    tail = element.tail
                    element.clear()
                    element.tail = tail
                    if stack:
                        try:
                            stack[-1].remove(element)
                        except ValueError:
                            pass
    except DefusedXmlException:
        raise ExtractError("corrupt", "The SVG file references external XML entities or resources, which are never read.") from None
    except ExtractError:
        raise
    except MemoryError:
        raise
    except Exception:
        raise ExtractError("corrupt", "The file is not a readable SVG drawing.") from None


# -- DXF --------------------------------------------------------------------------

_BINARY_DXF = b"AutoCAD Binary DXF"
# Entities with text, and the group codes that hold it.
_TEXT_ENTITIES = {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION", "MLEADER", "MULTILEADER", "RTEXT"}
MAX_DXF_LINE_BYTES = 64 * 1024

_MTEXT_FORMAT = re.compile(
    r"\\[ACcfFHQTWp][^;\\]*;"        # \fArial|b0|i0;  \H2.5x;  \C1;  \pxi-3,l3;
    r"|\\S([^;]*?)[\^#/]([^;]*?);"   # stacked fractions \S1/2;
    r"|\\[LlOoKkNX]"                 # underline/overline/strike toggles, column breaks
)
_SPECIAL = re.compile(r"%%(?:([dDpPcC])|([uUoOkK])|(\d{3}))")
_UNICODE = re.compile(r"\\U\+([0-9A-Fa-f]{4})")
_CODEPAGE = re.compile(r"ANSI_(\d{3,4})", re.I)


def _special(match: re.Match) -> str:
    symbol, toggle, code = match.groups()
    if symbol:
        return {"d": "°", "p": "±", "c": "⌀"}[symbol.lower()]
    if toggle:
        return ""
    try:
        return chr(int(code))
    except ValueError:
        return ""


def _mtext_plain(text: str) -> str:
    """Strip MTEXT formatting codes, keep the visible characters."""
    text = text.replace("\\\\", "\x00b").replace("\\{", "\x00o").replace("\\}", "\x00c")
    text = re.sub(r"\\[Pn]", "\n", text)
    text = text.replace("\\~", " ")

    def stacked(match: re.Match) -> str:
        if match.group(1) is not None or match.group(2) is not None:
            return f"{match.group(1) or ''}/{match.group(2) or ''}"
        return ""

    text = _MTEXT_FORMAT.sub(stacked, text)
    text = text.replace("{", "").replace("}", "")
    return text.replace("\x00b", "\\").replace("\x00o", "{").replace("\x00c", "}")


def _plain(text: str, mtext: bool) -> str:
    text = _UNICODE.sub(lambda m: chr(int(m.group(1), 16)), text)
    if mtext:
        text = _mtext_plain(text)
    text = _SPECIAL.sub(_special, text)
    return "\n".join(" ".join(line.split()) for line in text.split("\n")).strip()


class _Decoder:
    """DXF before AutoCAD 2007 is in the drawing's ANSI code page
    ($DWGCODEPAGE), later versions are UTF-8."""

    def __init__(self) -> None:
        self.codepage = "cp1252"

    def __call__(self, raw: bytes) -> str:
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode(self.codepage, "replace")

    def set_codepage(self, value: str) -> None:
        match = _CODEPAGE.search(value)
        if match:
            import codecs

            candidate = "cp" + match.group(1)
            try:
                codecs.lookup(candidate)
                self.codepage = candidate
            except LookupError:
                pass


def _pairs(fh):
    """Yield (group code, raw value) from an ASCII DXF stream."""
    while True:
        code_line = fh.readline(MAX_DXF_LINE_BYTES)
        if not code_line:
            return
        value_line = fh.readline(MAX_DXF_LINE_BYTES)
        if not value_line:
            return
        try:
            code = int(code_line)
        except ValueError:
            raise ExtractError("corrupt", "The file is not a readable DXF drawing.") from None
        yield code, value_line.rstrip(b"\r\n")


def _entity_text(kind: str, groups: dict[int, list[str]]) -> str:
    if kind == "MTEXT":
        return _plain("".join(groups.get(3, [])) + "".join(groups.get(1, [])), True)
    if kind in ("ATTRIB", "ATTDEF"):
        value = _plain("".join(groups.get(1, [])), False)
        tag = _plain("".join(groups.get(2, [])), False)
        if not value:
            return ""
        return f"{tag}: {value}" if tag else value
    if kind in ("MLEADER", "MULTILEADER"):
        return _plain("".join(groups.get(304, [])), True)
    if kind == "DIMENSION":
        value = "".join(groups.get(1, []))
        # "<>" stands for the measured value, which is not in the file as text.
        return "" if value.strip() in ("", "<>", " ") else _plain(value.replace("<>", ""), True)
    return _plain("".join(groups.get(1, [])), kind == "RTEXT")


def extract_dxf(job: Job) -> None:
    """ASCII DXF: TEXT, MTEXT (formatting codes stripped), ATTRIB/ATTDEF
    (``TAG: value``), dimension text overrides and multileader text, from
    model space, paper space and block definitions, in file order."""
    with open(job.path, "rb") as fh:
        if fh.read(len(_BINARY_DXF)) == _BINARY_DXF:
            raise ExtractError("unsupported", "Binary DXF files are not supported. Save the drawing as ASCII DXF to make its text searchable.")
        fh.seek(0)
        if fh.read(3) != b"\xef\xbb\xbf":
            fh.seek(0)
        decode = _Decoder()
        kind: str | None = None
        groups: dict[int, list[str]] = {}
        seen_section = False
        expect_codepage = False
        for code, raw in _pairs(fh):
            if code == 9:
                expect_codepage = raw.strip().upper() == b"$DWGCODEPAGE"
                continue
            if expect_codepage and code == 3:
                decode.set_codepage(decode(raw))
                expect_codepage = False
                continue
            if code != 0:
                if kind is not None and code in (1, 2, 3, 304):
                    groups.setdefault(code, []).append(decode(raw))
                continue
            # Group code 0 starts a new entity: emit the previous one.
            if kind is not None:
                text = _entity_text(kind, groups)
                if text:
                    if job.out.full:
                        job.out.mark_truncated()
                        return
                    job.out.add_block(text)
            name = raw.strip().upper().decode("ascii", "replace")
            kind = name if name in _TEXT_ENTITIES else None
            seen_section = seen_section or name == "SECTION"
            groups = {}
            if name == "EOF":
                break
        if kind is not None:
            text = _entity_text(kind, groups)
            if text:
                job.out.add_block(text)
        if not seen_section:
            raise ExtractError("corrupt", "The file is not a readable DXF drawing.")
