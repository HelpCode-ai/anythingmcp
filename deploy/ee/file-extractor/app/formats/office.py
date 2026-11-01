# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Office Open XML documents: .docx (python-docx) and .pptx (python-pptx)."""

from __future__ import annotations

import re

from ..errors import ExtractError
from ..job import Job

SEP = " · "
_WS = re.compile(r"\s*\n\s*")


def _core_meta(job: Job, core) -> None:
    try:
        job.meta["title"] = (core.title or "").strip()[:500] or None
        job.meta["author"] = (core.author or "").strip()[:500] or None
    except Exception:
        pass


def _docx_table_lines(table) -> list[str]:
    from docx.table import _Cell

    lines = []
    for tr in table._tbl.tr_lst:
        cells = []
        for tc in tr.tc_lst:
            text = _WS.sub(" ", _Cell(tc, table).text).strip()
            if text:
                cells.append(text)
        if cells:
            lines.append(SEP.join(cells))
    return lines


def extract_docx(job: Job) -> None:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        document = docx.Document(job.path)
    except Exception as exc:
        raise ExtractError("corrupt", f"The file is not a readable Word document ({type(exc).__name__}).") from None
    _core_meta(job, document.core_properties)
    for item in document.iter_inner_content():
        if job.out.full:
            job.out.mark_truncated()
            break
        if isinstance(item, Paragraph):
            job.out.add_block(item.text)
        elif isinstance(item, Table):
            for line in _docx_table_lines(item):
                job.out.add_block(line)


def _iter_shapes(shapes):
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    for shape in shapes:
        try:
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from _iter_shapes(shape.shapes)
                continue
        except Exception:
            pass
        yield shape


def _shape_text(shape) -> list[str]:
    parts: list[str] = []
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        text = shape.text_frame.text.strip()
        if text:
            parts.append(text)
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            cells = [_WS.sub(" ", cell.text).strip() for cell in row.cells]
            cells = [c for c in cells if c]
            if cells:
                parts.append(SEP.join(cells))
    return parts


def extract_pptx(job: Job) -> None:
    from pptx import Presentation

    try:
        presentation = Presentation(job.path)
    except Exception as exc:
        raise ExtractError("corrupt", f"The file is not a readable PowerPoint file ({type(exc).__name__}).") from None
    _core_meta(job, presentation.core_properties)
    slides = list(presentation.slides)
    job.meta["pageCount"] = len(slides)
    for number, slide in enumerate(slides, 1):
        if job.out.full:
            job.out.mark_truncated()
            break
        parts: list[str] = []
        title_id = None
        try:
            title = slide.shapes.title
            if title is not None:
                title_id = title.shape_id
                parts.extend(_shape_text(title))
        except Exception:
            pass
        for shape in _iter_shapes(slide.shapes):
            try:
                if title_id is not None and shape.shape_id == title_id:
                    continue
                parts.extend(_shape_text(shape))
            except Exception:
                continue
        try:
            if slide.has_notes_slide:
                notes = slide.notes_slide.notes_text_frame
                notes_text = notes.text.strip() if notes is not None else ""
                if notes_text:
                    parts.append("Notes: " + notes_text)
        except Exception:
            pass
        job.out.add_page(number, "\n".join(parts))
