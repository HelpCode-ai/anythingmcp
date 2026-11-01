# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Spreadsheets rendered row-wise with their header.

The first non-empty row of a sheet is its header. Every later non-empty row
becomes one self-contained line, so a search for an article number returns
the whole row with its column names::

    Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412

Rows are grouped into numbered segments (``page`` = 1-based segment number
across the workbook); a segment never spans two sheets.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import os
import re

from ..errors import ExtractError
from ..job import Job
from ..textdecode import decode_bytes, read_capped
from .legacy import run_tool

ROWS_PER_SEGMENT = 200
# Very wide rows: also close a segment once it holds this many characters.
MAX_SEGMENT_CHARS = 32_000
SEP = " · "
# Repeated identical rows/cells (ODS) are expanded at most this often.
MAX_REPEAT = 1000

_WS = re.compile(r"\s*[\r\n\t]+\s*")


def column_letter(index: int) -> str:
    """0-based column index -> Excel column letters (0 -> A, 26 -> AA)."""
    index += 1
    letters = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def format_number(value: float) -> str:
    if value != value or value in (float("inf"), float("-inf")):
        return ""
    rounded = round(value, 9)
    if rounded == int(rounded) and abs(rounded) < 1e16:
        return str(int(rounded))
    text = repr(rounded)
    if "e" in text or "E" in text:
        text = f"{rounded:.9f}".rstrip("0").rstrip(".")
    return text


def format_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format_number(value)
    if isinstance(value, dt.datetime):
        if value.hour == value.minute == value.second == value.microsecond == 0:
            return value.date().isoformat()
        return value.replace(microsecond=0, tzinfo=None).isoformat()
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    text = str(value)
    return _WS.sub(" ", text).strip()


class SheetWriter:
    """Turns (row number, sparse cells) into numbered segments."""

    def __init__(self, job: Job) -> None:
        self.job = job
        self.segment = 0
        self.sheet_count = 0
        self._name = ""
        self._header: dict[int, str] | None = None
        self._lines: list[str] = []
        self._chars = 0

    def begin_sheet(self, name: str) -> None:
        self.sheet_count += 1
        self._name = format_value(name)[:200] or f"Sheet{self.sheet_count}"
        self._header = None
        self._lines = []
        self._chars = 0

    def row(self, row_number: int, cells) -> None:
        """``cells``: iterable of (0-based column, raw value)."""
        values = []
        for column, raw in cells:
            text = format_value(raw)
            if text:
                values.append((column, text))
        if not values:
            return
        prefix = f'Sheet "{self._name}"'
        if self._header is None:
            self._header = {column: text for column, text in values}
            self._append(f"{prefix} columns: " + SEP.join(text for _, text in values))
            return
        parts = [
            f"{self._header.get(column) or column_letter(column)}={text}"
            for column, text in values
        ]
        self._append(f"{prefix} row {row_number}: " + SEP.join(parts))

    def _append(self, line: str) -> None:
        self._lines.append(line)
        self._chars += len(line) + 1
        if len(self._lines) >= ROWS_PER_SEGMENT or self._chars >= MAX_SEGMENT_CHARS:
            self._flush()

    def _flush(self) -> None:
        if self._lines:
            self.segment += 1
            self.job.out.add_page(self.segment, "\n".join(self._lines))
        self._lines = []
        self._chars = 0

    def end_sheet(self) -> None:
        self._flush()

    @property
    def full(self) -> bool:
        return self.job.out.full

    def finish(self) -> None:
        self._flush()
        self.job.meta["sheetCount"] = self.sheet_count


# -- xlsx / xlsm ------------------------------------------------------------

def _xlsx_rows(ws):
    """Yield (row number, [(col, value)]) without materialising empty cells.

    Uses openpyxl's streaming worksheet parser directly: ``iter_rows`` pads
    every row to the widest column, which a hostile sheet can make huge.
    """
    from openpyxl.worksheet._reader import WorkSheetParser

    wb = ws.parent
    with ws._get_source() as src:
        parser = WorkSheetParser(
            src,
            ws._shared_strings,
            data_only=wb.data_only,
            epoch=wb.epoch,
            date_formats=wb._date_formats,
            timedelta_formats=wb._timedelta_formats,
        )
        for index, row in parser.parse():
            yield index, [(cell["column"] - 1, cell["value"]) for cell in row]


def extract_xlsx(job: Job) -> None:
    import zipfile

    import openpyxl
    from openpyxl.worksheet._read_only import ReadOnlyWorksheet

    try:
        wb = openpyxl.load_workbook(job.path, read_only=True, data_only=True, keep_links=False)
    except (zipfile.BadZipFile, KeyError, ValueError, TypeError, OSError) as exc:
        raise ExtractError("corrupt", f"The file is not a readable Excel workbook ({type(exc).__name__}).") from None
    try:
        props = wb.properties
        job.meta["title"] = (props.title or None) if props else None
        job.meta["author"] = (props.creator or None) if props else None
        writer = SheetWriter(job)
        for ws in wb.worksheets:
            if writer.full:
                job.out.mark_truncated()
                break
            writer.begin_sheet(ws.title)
            if isinstance(ws, ReadOnlyWorksheet):
                rows = _xlsx_rows(ws)
            else:  # pragma: no cover - read_only always yields ReadOnlyWorksheet
                rows = ((i, list(enumerate(r))) for i, r in enumerate(ws.iter_rows(values_only=True), 1))
            for number, cells in rows:
                if writer.full:
                    job.out.mark_truncated()
                    break
                writer.row(number, cells)
            writer.end_sheet()
        writer.finish()
    finally:
        wb.close()


# -- xls ----------------------------------------------------------------------

def _xls_value(cell, datemode):
    import xlrd

    ctype = cell.ctype
    if ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
        return None
    if ctype == xlrd.XL_CELL_DATE:
        try:
            return xlrd.xldate_as_datetime(cell.value, datemode)
        except Exception:
            return cell.value
    if ctype == xlrd.XL_CELL_BOOLEAN:
        return bool(cell.value)
    return cell.value


def extract_xls(job: Job) -> None:
    import xlrd

    try:
        book = xlrd.open_workbook(job.path, on_demand=True, formatting_info=False, logfile=io.StringIO())
    except Exception as exc:
        if "encrypt" in str(exc).lower():
            raise ExtractError("encrypted", "The Excel file is password-protected.") from None
        _extract_xls_with_xls2csv(job)
        return
    try:
        writer = SheetWriter(job)
        for index in range(book.nsheets):
            if writer.full:
                job.out.mark_truncated()
                break
            sheet = book.sheet_by_index(index)
            writer.begin_sheet(sheet.name)
            for r in range(sheet.nrows):
                if writer.full:
                    job.out.mark_truncated()
                    break
                cells = [(c, _xls_value(cell, book.datemode)) for c, cell in enumerate(sheet.row(r))]
                writer.row(r + 1, cells)
            writer.end_sheet()
            book.unload_sheet(index)
        writer.finish()
    finally:
        book.release_resources()


def _extract_xls_with_xls2csv(job: Job) -> None:
    """Fallback for workbooks xlrd rejects: catdoc's xls2csv."""
    out_path = job.scratch_path(".csv")
    code, stderr = run_tool(["xls2csv", "-d", "utf-8", "-q", "1", "-c", ",", job.path], job, out_path)
    if "encrypt" in stderr.lower():
        raise ExtractError("encrypted", "The Excel file is password-protected.")
    data, more = read_capped(out_path, job.max_chars)
    if code != 0 or not data.strip():
        raise ExtractError("corrupt", "The file is not a readable Excel workbook.")
    writer = SheetWriter(job)
    text = decode_bytes(data)
    csv.field_size_limit(10 * 1024 * 1024)
    for number, chunk in enumerate(text.split("\f"), 1):
        if not chunk.strip():
            continue
        if writer.full:
            job.out.mark_truncated()
            break
        writer.begin_sheet(f"Sheet{number}")
        for row_number, row in enumerate(csv.reader(io.StringIO(chunk)), 1):
            if writer.full:
                job.out.mark_truncated()
                break
            writer.row(row_number, list(enumerate(row)))
        writer.end_sheet()
    writer.finish()
    if more:
        job.out.mark_truncated()


# -- csv / tsv ------------------------------------------------------------------

def _sniff_delimiter(sample: str, ext: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        pass
    if ext == "tsv":
        return "\t"
    first = sample.split("\n", 1)[0]
    counts = {d: first.count(d) for d in (";", ",", "\t", "|")}
    best = max(counts, key=counts.get)
    return best if counts[best] else ","


def extract_csv(job: Job) -> None:
    data, more = read_capped(job.path, job.max_chars)
    text = decode_bytes(data)
    if more:
        # The cut may end inside a row; drop the incomplete last line.
        text = text.rsplit("\n", 1)[0]
    sample = text[:65536]
    if "\n" in sample:
        sample = sample.rsplit("\n", 1)[0]
    delimiter = "\t" if job.ext == "tsv" and "\t" in sample else _sniff_delimiter(sample, job.ext)
    csv.field_size_limit(10 * 1024 * 1024)
    name = os.path.splitext(os.path.basename(job.name.replace("\\", "/")))[0] or job.ext.upper()
    writer = SheetWriter(job)
    writer.begin_sheet(name)
    try:
        for row_number, row in enumerate(csv.reader(io.StringIO(text), delimiter=delimiter), 1):
            if writer.full:
                job.out.mark_truncated()
                break
            writer.row(row_number, list(enumerate(row)))
    except csv.Error:
        raise ExtractError("corrupt", "The file is not a readable CSV file.") from None
    writer.end_sheet()
    writer.finish()
    if more:
        job.out.mark_truncated()
