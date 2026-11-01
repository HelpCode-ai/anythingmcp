# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Child-process side of one extraction.

The parent starts ``child_main`` in a fresh interpreter (multiprocessing
"spawn"), waits with a deadline and kills the whole process group when it
expires. The child never talks to the network; it writes its result as JSON
into the job directory and exits.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import warnings

from .errors import ExtractError, error_result


def _harden(spec: dict) -> None:
    # Own process group, so the parent can kill helper tools (antiword, ...)
    # together with this process.
    if hasattr(os, "setpgrp"):
        try:
            os.setpgrp()
        except OSError:
            pass
    # The shared token is not needed here; do not keep it around.
    for name in ("EXTRACTOR_TOKEN",):
        os.environ.pop(name, None)
    os.environ["TMPDIR"] = spec["workdir"]
    os.environ["HOME"] = spec["workdir"]
    tempfile.tempdir = spec["workdir"]
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        memory_mb = int(spec.get("memoryMb") or 0)
        # ONNX Runtime (OCR) reserves several GB of address space for its
        # thread pools and fails or hangs under RLIMIT_AS, so OCR jobs rely
        # on the container memory limit alone.
        if memory_mb > 0 and not spec.get("ocr") and sys.platform.startswith("linux"):
            limit = memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, ValueError, OSError):
        pass
    # Libraries log and warn freely, sometimes with document content (names,
    # header values). Nothing from inside a document may reach the logs.
    logging.disable(logging.CRITICAL)
    warnings.simplefilter("ignore")


def _result(job) -> dict:
    out = job.out
    out.finish()
    meta = job.meta
    if not out.pages:
        if job.empty_pages and meta.get("pageCount") and job.empty_pages >= meta["pageCount"]:
            message = "The PDF has no text layer (it is probably scanned); OCR can read it."
            if job.ocr:
                message = "No text could be read from the PDF, not even with OCR."
        else:
            message = "No text could be extracted from the document."
        return error_result("empty", message, meta, ocr_pages=job.ocr_pages, empty_pages=job.empty_pages)
    return {
        "ok": True,
        "pages": out.pages,
        "meta": meta,
        "truncated": out.truncated,
        "ocrPages": job.ocr_pages,
        "emptyPages": job.empty_pages,
        "error": None,
    }


def extract_to_result(spec: dict) -> dict:
    from .formats import run_extraction
    from .job import Job

    job = Job(
        path=spec["path"],
        ext=spec["ext"],
        name=spec.get("name", ""),
        workdir=spec["workdir"],
        max_chars=spec["maxChars"],
        ocr=bool(spec.get("ocr")),
        tool_timeout=float(spec.get("timeout", 60)),
    )
    try:
        run_extraction(job)
    except ExtractError as exc:
        return error_result(exc.kind, exc.message, job.meta,
                            ocr_pages=job.ocr_pages, empty_pages=job.empty_pages)
    except MemoryError:
        return error_result("too_large", "The document needs more memory than the extractor allows.", job.meta)
    except RecursionError:
        return error_result("corrupt", "The document is nested too deeply to be read.", job.meta)
    except Exception as exc:  # any parser failure on hostile input
        return error_result("corrupt", f"The document could not be read ({type(exc).__name__}).", job.meta)
    return _result(job)


def render_job_result(spec: dict) -> dict:
    from .render import render_to_result

    try:
        return render_to_result(spec)
    except ExtractError as exc:
        return render_error(exc.kind, exc.message)
    except MemoryError:
        return render_error("too_large", "The picture needs more memory than the extractor allows.")
    except Exception as exc:  # any decoder failure on hostile input
        return render_error("damaged", f"The file could not be shown ({type(exc).__name__}).")


def render_error(kind: str, message: str) -> dict:
    """Result of a failed ``/render``: no pages or text counters, and
    ``corrupt`` is called ``damaged`` there."""
    return {"ok": False, "error": {"kind": "damaged" if kind == "corrupt" else kind, "message": message}}


def child_main(spec: dict, result_path: str) -> None:
    _harden(spec)
    try:
        if spec.get("kind") == "render":
            result = render_job_result(spec)
        else:
            result = extract_to_result(spec)
    except MemoryError:
        result = error_result("too_large", "The document needs more memory than the extractor allows.")
    tmp_path = result_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    os.replace(tmp_path, result_path)
