# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Apple iWork (.pages, .numbers, .key): the text of the PDF preview.

The iWork document format itself (snappy-compressed protobuf) has no free
reader. Files saved with a PDF preview (``QuickLook/Preview.pdf``, or
``preview.pdf``) are read through that PDF, page by page; the others are
reported as unsupported.
"""

from __future__ import annotations

import shutil
import zipfile

from ..errors import ExtractError
from ..job import Job

# The preview is copied to the job's temp directory; never more than this.
MAX_PREVIEW_BYTES = 200 * 1024 * 1024
_PREVIEW_NAMES = ("quicklook/preview.pdf", "preview.pdf")
_NAMES = {"pages": "Pages document", "numbers": "Numbers spreadsheet", "key": "Keynote presentation"}


def extract_iwork(job: Job) -> None:
    from .pdf import extract_pdf

    label = _NAMES.get(job.ext, "iWork document")
    try:
        zf = zipfile.ZipFile(job.path)
    except (zipfile.BadZipFile, OSError):
        raise ExtractError("corrupt", f"The file is not a valid {label}.") from None
    with zf:
        by_name = {info.filename.lower(): info for info in zf.infolist()}
        info = next((by_name[n] for n in _PREVIEW_NAMES if n in by_name), None)
        if info is None:
            raise ExtractError(
                "unsupported",
                f"This {label} has no PDF preview, and the iWork format itself cannot be read. "
                "Export it as PDF (or Word, Excel, PowerPoint) to make its text searchable.",
            )
        if info.file_size > MAX_PREVIEW_BYTES:
            raise ExtractError("too_large", f"The PDF preview of the {label} is too large.")
        preview = job.scratch_path(".pdf")
        with zf.open(info) as src, open(preview, "wb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
            if dst.tell() > MAX_PREVIEW_BYTES:  # pragma: no cover - sizes are checked above
                raise ExtractError("too_large", f"The PDF preview of the {label} is too large.")
    # Same output, counters and meta as the job itself; only the path differs.
    sub = Job(path=preview, ext="pdf", workdir=job.workdir, max_chars=job.max_chars, name=job.name,
              ocr=job.ocr, tool_timeout=job.tool_timeout, out=job.out, meta=job.meta,
              is_attachment=job.is_attachment, _counter=job._counter)
    try:
        extract_pdf(sub)
    except ExtractError as exc:
        if exc.kind == "encrypted":
            raise ExtractError("encrypted", f"The {label} is password-protected.") from None
        raise ExtractError(exc.kind, f"The PDF preview of the {label} could not be read.") from None
    finally:
        job.ocr_pages += sub.ocr_pages
        job.empty_pages += sub.empty_pages
