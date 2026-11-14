# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""OpenDocument (.odt, .ods, .odp) with a small streaming reader.

``content.xml`` is read with ``defusedxml``'s ``iterparse`` (no entity
expansion, no external resources) and processed element by element, so
memory stays flat even for large documents. Repeated rows and columns in
spreadsheets (``number-rows-repeated`` can declare a million empty rows)
are counted, never expanded, unless they hold data.
"""

from __future__ import annotations

import zipfile

from ..errors import ExtractError
from ..job import Job
from .spreadsheet import MAX_REPEAT, SheetWriter

SEP = " · "
_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "draw": "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
    "presentation": "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
    "dc": "http://purl.org/dc/elements/1.1/",
    "meta": "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
}


def _q(prefix: str, name: str) -> str:
    return "{%s}%s" % (_NS[prefix], name)


TEXT_P = _q("text", "p")
TEXT_H = _q("text", "h")
TEXT_S = _q("text", "s")
TEXT_C = _q("text", "c")
TEXT_TAB = _q("text", "tab")
TEXT_LB = _q("text", "line-break")
TEXT_SPAN = _q("text", "span")
TEXT_A = _q("text", "a")
TABLE_TABLE = _q("table", "table")
TABLE_NAME = _q("table", "name")
TABLE_ROW = _q("table", "table-row")
TABLE_CELL = _q("table", "table-cell")
TABLE_COVERED = _q("table", "covered-table-cell")
ROWS_REPEATED = _q("table", "number-rows-repeated")
COLS_REPEATED = _q("table", "number-columns-repeated")
VALUE_TYPE = _q("office", "value-type")
VALUE = _q("office", "value")
DATE_VALUE = _q("office", "date-value")
TIME_VALUE = _q("office", "time-value")
BOOLEAN_VALUE = _q("office", "boolean-value")
DRAW_PAGE = _q("draw", "page")
PRES_NOTES = _q("presentation", "notes")
_INLINE = {TEXT_P, TEXT_H, TEXT_SPAN, TEXT_A}
_SKIP_IN_PARAGRAPH = {TEXT_P, TEXT_H, TABLE_TABLE}

MAX_META_BYTES = 1024 * 1024


class _Stop(Exception):
    """Raised from callbacks once the character budget is used up."""


def _iterparse(fh):
    from defusedxml.ElementTree import iterparse

    return iterparse(fh, events=("start", "end"), forbid_dtd=False, forbid_entities=True, forbid_external=True)


def _paragraph_text(element) -> str:
    parts: list[str] = []

    def walk(node) -> None:
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = child.tag
            if tag == TEXT_S:
                try:
                    count = int(child.get(TEXT_C) or 1)
                except ValueError:
                    count = 1
                parts.append(" " * max(1, min(count, 100)))
            elif tag == TEXT_TAB:
                parts.append("\t")
            elif tag == TEXT_LB:
                parts.append("\n")
            elif tag in _SKIP_IN_PARAGRAPH:
                pass  # nested paragraphs/tables are emitted on their own
            else:
                walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(element)
    return "".join(parts)


def _release(element, parent) -> None:
    """Free a processed element but keep its tail for the enclosing text."""
    tail = element.tail
    element.clear()
    element.tail = tail
    if parent is not None and parent.tag not in _INLINE:
        try:
            parent.remove(element)
        except ValueError:
            pass


def _open(job: Job, label: str) -> zipfile.ZipFile:
    try:
        zf = zipfile.ZipFile(job.path)
    except (zipfile.BadZipFile, OSError):
        raise ExtractError("corrupt", f"The file is not a valid {label} file.") from None
    names = set(zf.namelist())
    if "META-INF/manifest.xml" in names:
        info = zf.getinfo("META-INF/manifest.xml")
        if info.file_size <= MAX_META_BYTES and b"encryption-data" in zf.read(info):
            zf.close()
            raise ExtractError("encrypted", f"The {label} file is password-protected.")
    if "content.xml" not in names:
        zf.close()
        raise ExtractError("corrupt", f"The file is not a valid {label} file (no content.xml).")
    _read_meta(job, zf, names)
    return zf


def _read_meta(job: Job, zf: zipfile.ZipFile, names: set[str]) -> None:
    if "meta.xml" not in names:
        return
    try:
        info = zf.getinfo("meta.xml")
        if info.file_size > MAX_META_BYTES:
            return
        from defusedxml.ElementTree import fromstring

        root = fromstring(zf.read(info), forbid_entities=True, forbid_external=True)
        title = root.find(".//" + _q("dc", "title"))
        author = root.find(".//" + _q("dc", "creator"))
        if author is None or not (author.text or "").strip():
            author = root.find(".//" + _q("meta", "initial-creator"))
        if title is not None and (title.text or "").strip():
            job.meta["title"] = title.text.strip()[:500]
        if author is not None and (author.text or "").strip():
            job.meta["author"] = author.text.strip()[:500]
    except Exception:
        pass


def _parse_error(label: str) -> ExtractError:
    return ExtractError("corrupt", f"The file is not a readable {label} file.")


def _stream_text(fh, on_paragraph, on_page_start=None, on_page_end=None) -> None:
    """Walk text documents and presentations; tables become ``a · b`` lines."""
    stack: list = []
    cells: list[list[str]] = []
    rows: list[list[str]] = []
    notes_depth = 0
    for event, element in _iterparse(fh):
        tag = element.tag
        if event == "start":
            stack.append(element)
            if tag == TABLE_ROW:
                rows.append([])
            elif tag in (TABLE_CELL, TABLE_COVERED):
                cells.append([])
            elif tag == DRAW_PAGE and on_page_start is not None:
                on_page_start()
            elif tag == PRES_NOTES:
                notes_depth += 1
            continue

        stack.pop()
        parent = stack[-1] if stack else None
        if tag in (TEXT_P, TEXT_H):
            text = _paragraph_text(element)
            if cells:
                cells[-1].append(text)
            else:
                on_paragraph(text, notes_depth > 0)
            _release(element, parent)
        elif tag in (TABLE_CELL, TABLE_COVERED):
            parts = cells.pop() if cells else []
            if rows:
                rows[-1].append(" ".join(p.strip() for p in parts if p.strip()))
            _release(element, parent)
        elif tag == TABLE_ROW:
            row = rows.pop() if rows else []
            line = SEP.join(c for c in row if c)
            if line:
                if cells:
                    cells[-1].append(line)
                else:
                    on_paragraph(line, notes_depth > 0)
            _release(element, parent)
        elif tag == PRES_NOTES:
            notes_depth -= 1
            _release(element, parent)
        elif tag == DRAW_PAGE:
            if on_page_end is not None:
                on_page_end()
            _release(element, parent)


def extract_odt(job: Job) -> None:
    label = "OpenDocument text"
    zf = _open(job, label)

    def on_paragraph(text: str, _in_notes: bool) -> None:
        if job.out.full:
            job.out.mark_truncated()
            raise _Stop
        job.out.add_block(text)

    try:
        with zf, zf.open("content.xml") as fh:
            _stream_text(fh, on_paragraph)
    except _Stop:
        pass
    except ExtractError:
        raise
    except Exception:
        raise _parse_error(label) from None


def extract_odp(job: Job) -> None:
    label = "OpenDocument presentation"
    zf = _open(job, label)
    state = {"page": 0, "body": [], "notes": []}

    def on_page_start() -> None:
        if job.out.full:
            job.out.mark_truncated()
            raise _Stop
        state["page"] += 1
        state["body"] = []
        state["notes"] = []

    def on_paragraph(text: str, in_notes: bool) -> None:
        if state["page"] == 0:
            return  # master pages and styles carry no slide content
        (state["notes"] if in_notes else state["body"]).append(text)

    def on_page_end() -> None:
        body = "\n".join(t for t in state["body"] if t.strip())
        notes = " ".join(t.strip() for t in state["notes"] if t.strip())
        if notes:
            body = f"{body}\nNotes: {notes}" if body else f"Notes: {notes}"
        job.out.add_page(state["page"], body)

    try:
        with zf, zf.open("content.xml") as fh:
            _stream_text(fh, on_paragraph, on_page_start, on_page_end)
    except _Stop:
        pass
    except ExtractError:
        raise
    except Exception:
        raise _parse_error(label) from None
    job.meta["pageCount"] = state["page"]


def _ods_value(element, paragraphs: list[str]):
    value_type = element.get(VALUE_TYPE)
    if value_type in ("float", "percentage", "currency"):
        raw = element.get(VALUE)
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
    elif value_type == "date":
        raw = element.get(DATE_VALUE) or ""
        if raw.endswith("T00:00:00"):
            raw = raw[: -len("T00:00:00")]
        if raw:
            return raw
    elif value_type == "time":
        raw = element.get(TIME_VALUE)
        if raw:
            return raw
    elif value_type == "boolean":
        raw = element.get(BOOLEAN_VALUE)
        if raw:
            return raw.lower() == "true"
    return "\n".join(p for p in paragraphs if p.strip())


def _repeat(element, attribute: str) -> int:
    try:
        return max(1, int(element.get(attribute) or 1))
    except ValueError:
        return 1


def extract_ods(job: Job) -> None:
    label = "OpenDocument spreadsheet"
    zf = _open(job, label)
    writer = SheetWriter(job)
    stack: list = []
    paragraphs: list[str] = []
    row_cells: list = []
    column = 0
    row_number = 0
    in_sheet = False
    try:
        with zf, zf.open("content.xml") as fh:
            for event, element in _iterparse(fh):
                tag = element.tag
                if event == "start":
                    stack.append(element)
                    if tag == TABLE_TABLE and not in_sheet:
                        if writer.full:
                            job.out.mark_truncated()
                            raise _Stop
                        writer.begin_sheet(element.get(TABLE_NAME) or "")
                        in_sheet = True
                        row_number = 0
                    elif tag == TABLE_ROW:
                        row_cells = []
                        column = 0
                    elif tag in (TABLE_CELL, TABLE_COVERED):
                        paragraphs = []
                    continue
                stack.pop()
                parent = stack[-1] if stack else None
                if tag in (TEXT_P, TEXT_H):
                    paragraphs.append(_paragraph_text(element))
                    _release(element, parent)
                elif tag in (TABLE_CELL, TABLE_COVERED):
                    repeat = _repeat(element, COLS_REPEATED)
                    value = _ods_value(element, paragraphs)
                    if value not in (None, ""):
                        for k in range(min(repeat, MAX_REPEAT)):
                            row_cells.append((column + k, value))
                    column += repeat
                    paragraphs = []
                    _release(element, parent)
                elif tag == TABLE_ROW:
                    repeat = _repeat(element, ROWS_REPEATED)
                    if row_cells:
                        for k in range(min(repeat, MAX_REPEAT)):
                            if writer.full:
                                job.out.mark_truncated()
                                raise _Stop
                            writer.row(row_number + 1 + k, row_cells)
                    row_number += repeat
                    row_cells = []
                    _release(element, parent)
                elif tag == TABLE_TABLE and in_sheet and not any(e.tag == TABLE_TABLE for e in stack):
                    writer.end_sheet()
                    in_sheet = False
                    _release(element, parent)
    except _Stop:
        pass
    except ExtractError:
        raise
    except Exception:
        raise _parse_error(label) from None
    writer.finish()
