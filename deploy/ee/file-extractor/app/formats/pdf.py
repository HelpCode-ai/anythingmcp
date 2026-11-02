# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""PDF: the text layer page by page (pypdfium2), optional OCR fallback."""

from __future__ import annotations

import math

from ..errors import ExtractError
from ..job import Job
from ..ocr import ocr_available, ocr_image

# A page with less text than this is counted as empty (and OCR'd if asked).
EMPTY_PAGE_CHARS = 50
OCR_DPI = 200
# Hostile PDFs can declare huge pages; never render more pixels than this.
MAX_RENDER_PIXELS = 40_000_000


def _meta_value(doc, key: str) -> str | None:
    try:
        value = doc.get_metadata_value(key)
    except Exception:
        return None
    value = (value or "").strip()
    return value[:500] or None


def _ocr_page(page) -> str:
    width, height = page.get_size()
    scale = OCR_DPI / 72.0
    pixels = max(width, 1) * scale * max(height, 1) * scale
    if pixels > MAX_RENDER_PIXELS:
        scale *= math.sqrt(MAX_RENDER_PIXELS / pixels)
    bitmap = page.render(scale=scale)
    try:
        image = bitmap.to_pil()
    finally:
        bitmap.close()
    return ocr_image(image)


def extract_pdf(job: Job) -> None:
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(job.path)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ExtractError("encrypted", "The PDF is password-protected.") from None
        raise ExtractError("corrupt", "The file is not a readable PDF.") from None

    try:
        job.meta["title"] = _meta_value(doc, "Title")
        job.meta["author"] = _meta_value(doc, "Author")
        page_count = len(doc)
        job.meta["pageCount"] = page_count
        use_ocr = job.ocr and ocr_available()

        for index in range(page_count):
            if job.out.full:
                job.out.mark_truncated()
                break
            page = doc[index]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                finally:
                    textpage.close()
                if len(text.strip()) < EMPTY_PAGE_CHARS and use_ocr:
                    job.ocr_pages += 1
                    recognised = _ocr_page(page)
                    if len(recognised.strip()) > len(text.strip()):
                        text = recognised
                if len(text.strip()) < EMPTY_PAGE_CHARS:
                    job.empty_pages += 1
                job.out.add_page(index + 1, text)
            finally:
                page.close()
    finally:
        doc.close()
