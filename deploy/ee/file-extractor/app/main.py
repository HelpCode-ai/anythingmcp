# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""HTTP API: POST /extract, POST /render, GET /health, GET /formats."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import ntpath
import os
import re
import shutil
import tempfile
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import API_VERSION
from .config import HARD_MAX_CHARS, extract_concurrency, load_settings
from .errors import empty_meta, error_result
from .formats import SUPPORTED_EXTENSIONS, unsupported_message
from .ocr import ocr_available
from .render import DEFAULT_MAX_PX, HARD_MAX_PX, MIN_MAX_PX, RENDER_EXTENSIONS
from .runner import run_job
from .worker import render_error

log = logging.getLogger("file_extractor")

# Multipart framing and the small text fields on top of the file itself.
FORM_OVERHEAD_BYTES = 256 * 1024
MAX_FIELD_BYTES = 64 * 1024
MAX_PARTS = 8
_SAFE_EXT = re.compile(r"^[a-z0-9]{1,10}$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.slots = asyncio.Semaphore(extract_concurrency())
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class _TooLarge(Exception):
    pass


class _BadForm(Exception):
    pass


def _ext_of(filename: str) -> str:
    base = ntpath.basename(filename.replace("/", "\\"))
    _, ext = os.path.splitext(base)
    return ext[1:].lower()


def _log_ext(ext: str) -> str:
    return ext if _SAFE_EXT.match(ext or "") else "other"


async def _receive_form(request: Request, file_path: str, max_bytes: int) -> tuple[dict, int, str | None, bool]:
    """Stream the multipart body: the file part to ``file_path``, small
    fields into memory. Stops as soon as the file exceeds ``max_bytes``.

    Returns (fields, file size, file part filename, file part seen).
    """
    from python_multipart.multipart import MultipartParser, parse_options_header

    content_type = request.headers.get("content-type", "")
    ctype, params = parse_options_header(content_type)
    boundary = params.get(b"boundary")
    if ctype != b"multipart/form-data" or not boundary:
        raise _BadForm("The request must be multipart/form-data.")

    state = {
        "fields": {},
        "header_field": b"",
        "header_value": b"",
        "headers": {},
        "name": None,
        "is_file": False,
        "buffer": bytearray(),
        "size": 0,
        "part_filename": None,
        "file_seen": False,
        "parts": 0,
    }
    out = open(file_path, "wb")

    def on_part_begin():
        state["parts"] += 1
        if state["parts"] > MAX_PARTS:
            raise _BadForm("Too many form fields.")
        state["headers"] = {}
        state["name"] = None
        state["is_file"] = False
        state["buffer"] = bytearray()

    def on_header_field(data, start, end):
        state["header_field"] += data[start:end]

    def on_header_value(data, start, end):
        state["header_value"] += data[start:end]

    def on_header_end():
        state["headers"][state["header_field"].lower()] = state["header_value"]
        state["header_field"] = b""
        state["header_value"] = b""

    def on_headers_finished():
        _disp, disp_params = parse_options_header(state["headers"].get(b"content-disposition", b""))
        name = disp_params.get(b"name", b"").decode("utf-8", "replace")
        state["name"] = name
        if name == "file" and not state["file_seen"]:
            state["is_file"] = True
            state["file_seen"] = True
            filename = disp_params.get(b"filename")
            if filename is not None:
                state["part_filename"] = filename.decode("utf-8", "replace")

    def on_part_data(data, start, end):
        chunk = data[start:end]
        if state["is_file"]:
            state["size"] += len(chunk)
            if state["size"] > max_bytes:
                raise _TooLarge()
            out.write(chunk)
        elif state["name"] in ("filename", "options"):
            if len(state["buffer"]) + len(chunk) > MAX_FIELD_BYTES:
                raise _BadForm(f"The form field {state['name']} is too long.")
            state["buffer"] += chunk
        # Unknown fields are ignored (and never buffered).

    def on_part_end():
        if not state["is_file"] and state["name"] in ("filename", "options"):
            state["fields"][state["name"]] = bytes(state["buffer"]).decode("utf-8", "replace")
        state["is_file"] = False

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": on_part_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
        },
    )
    received = 0
    try:
        async for chunk in request.stream():
            if chunk:
                received += len(chunk)
                if received > max_bytes + FORM_OVERHEAD_BYTES:
                    raise _TooLarge()
                parser.write(chunk)
        parser.finalize()
    except (_TooLarge, _BadForm):
        raise
    except Exception as exc:
        if state["size"] > max_bytes:
            raise _TooLarge() from None
        raise _BadForm(f"The multipart body could not be parsed ({type(exc).__name__}).") from None
    finally:
        out.close()
    return state["fields"], state["size"], state["part_filename"], state["file_seen"]


def _parse_options(raw: str | None) -> dict:
    options = {"ocr": False, "maxChars": HARD_MAX_CHARS}
    if raw is None or not raw.strip():
        return options
    try:
        value = json.loads(raw)
    except ValueError:
        raise _BadForm("options must be a JSON object.") from None
    if not isinstance(value, dict):
        raise _BadForm("options must be a JSON object.")
    if "ocr" in value:
        if not isinstance(value["ocr"], bool):
            raise _BadForm("options.ocr must be true or false.")
        options["ocr"] = value["ocr"]
    if "maxChars" in value and value["maxChars"] is not None:
        max_chars = value["maxChars"]
        if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars < 1:
            raise _BadForm("options.maxChars must be a positive integer.")
        options["maxChars"] = min(max_chars, HARD_MAX_CHARS)
    return options


def _bad_request(message: str) -> JSONResponse:
    return JSONResponse({"detail": message}, status_code=400)


@app.get("/health")
async def health():
    return {"ok": True, "ocr": ocr_available(), "version": API_VERSION}


@app.get("/formats")
async def formats():
    return ["." + ext for ext in SUPPORTED_EXTENSIONS]


@app.post("/extract")
async def extract(request: Request):
    settings = load_settings()
    if not settings.token:
        return JSONResponse({"detail": "The extractor is not configured (EXTRACTOR_TOKEN is empty)."}, status_code=503)
    supplied = request.headers.get("x-extractor-token", "")
    if not hmac.compare_digest(supplied.encode("utf-8"), settings.token.encode("utf-8")):
        return JSONResponse({"detail": "Invalid or missing X-Extractor-Token."}, status_code=401)

    started = time.monotonic()
    max_bytes = settings.max_input_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + FORM_OVERHEAD_BYTES:
        result = error_result("too_large", f"The file is larger than the limit of {max_bytes} bytes.")
        log.info("extract ext=unknown bytes=%s ms=%d result=error:too_large", declared, (time.monotonic() - started) * 1000)
        return JSONResponse(result)

    slots: asyncio.Semaphore = request.app.state.slots
    try:
        await asyncio.wait_for(slots.acquire(), timeout=settings.queue_timeout_seconds)
    except asyncio.TimeoutError:
        log.warning("extract rejected: all extraction slots busy")
        return JSONResponse({"detail": "The extractor is busy; retry later."}, status_code=503,
                            headers={"Retry-After": "10"})

    workdir = None
    ext = ""
    size = 0
    try:
        os.makedirs(settings.tmp_root, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix="fx-", dir=settings.tmp_root)
        input_path = os.path.join(workdir, "input.bin")
        try:
            fields, size, part_filename, file_seen = await _receive_form(request, input_path, max_bytes)
        except _TooLarge:
            result = error_result("too_large", f"The file is larger than the limit of {max_bytes} bytes.")
            log.info("extract ext=unknown bytes>%d ms=%d result=error:too_large", max_bytes, (time.monotonic() - started) * 1000)
            return JSONResponse(result)
        except _BadForm as exc:
            return _bad_request(str(exc))
        if not file_seen:
            return _bad_request("The form field 'file' is missing.")
        try:
            options = _parse_options(fields.get("options"))
        except _BadForm as exc:
            return _bad_request(str(exc))

        filename = fields.get("filename") or part_filename or ""
        ext = _ext_of(filename)
        meta = empty_meta(ext or None)
        if ext not in SUPPORTED_EXTENSIONS:
            result = error_result("unsupported", unsupported_message(ext), meta)
        elif size == 0:
            result = error_result("empty", "The file is empty.", meta)
        else:
            # Some parsers insist on a known extension (openpyxl). The name is
            # built from the allow-listed extension only, never the upload name.
            typed_path = os.path.join(workdir, f"input.{ext}")
            os.replace(input_path, typed_path)
            input_path = typed_path
            timeout = settings.timeout_seconds if size <= settings.large_input_bytes else settings.large_timeout_seconds
            spec = {
                "path": input_path,
                "ext": ext,
                "name": filename[-300:],
                "workdir": workdir,
                "maxChars": options["maxChars"],
                "ocr": options["ocr"] and ocr_available(),
                "timeout": timeout,
                "memoryMb": settings.child_memory_mb,
            }
            result = await run_job(spec, timeout)
            result.setdefault("meta", meta)
            if result.get("meta") and not result["meta"].get("format"):
                result["meta"]["format"] = ext

        kind = "ok" if result.get("ok") else "error:" + (result.get("error") or {}).get("kind", "unknown")
        log.info(
            "extract ext=%s bytes=%d ms=%d result=%s pages=%d truncated=%s",
            _log_ext(ext), size, (time.monotonic() - started) * 1000, kind,
            len(result.get("pages") or []), bool(result.get("truncated")),
        )
        return JSONResponse(result)
    finally:
        slots.release()
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)


# -- POST /render -------------------------------------------------------------------

def _parse_render_options(raw: str | None) -> dict:
    options = {"page": 1, "maxPx": DEFAULT_MAX_PX}
    if raw is None or not raw.strip():
        return options
    try:
        value = json.loads(raw)
    except ValueError:
        raise _BadForm("options must be a JSON object.") from None
    if not isinstance(value, dict):
        raise _BadForm("options must be a JSON object.")
    for key, low, high in (("page", 1, 100_000), ("maxPx", MIN_MAX_PX, None)):
        if key in value and value[key] is not None:
            v = value[key]
            if isinstance(v, bool) or not isinstance(v, int) or v < low or (high is not None and v > high):
                raise _BadForm(f"options.{key} must be an integer of at least {low}.")
            options[key] = v
    options["maxPx"] = min(options["maxPx"], HARD_MAX_PX)
    return options


@app.post("/render")
async def render(request: Request):
    """One page of a PDF, or an image, as a JPEG (base64 in JSON)."""
    settings = load_settings()
    if not settings.token:
        return JSONResponse({"detail": "The extractor is not configured (EXTRACTOR_TOKEN is empty)."}, status_code=503)
    supplied = request.headers.get("x-extractor-token", "")
    if not hmac.compare_digest(supplied.encode("utf-8"), settings.token.encode("utf-8")):
        return JSONResponse({"detail": "Invalid or missing X-Extractor-Token."}, status_code=401)

    started = time.monotonic()
    max_bytes = settings.max_input_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + FORM_OVERHEAD_BYTES:
        log.info("render ext=unknown bytes=%s ms=%d result=error:too_large", declared, (time.monotonic() - started) * 1000)
        return JSONResponse(render_error("too_large", f"The file is larger than the limit of {max_bytes} bytes."))

    slots: asyncio.Semaphore = request.app.state.slots
    try:
        await asyncio.wait_for(slots.acquire(), timeout=settings.queue_timeout_seconds)
    except asyncio.TimeoutError:
        log.warning("render rejected: all extraction slots busy")
        return JSONResponse({"detail": "The extractor is busy; retry later."}, status_code=503,
                            headers={"Retry-After": "10"})

    workdir = None
    ext = ""
    size = 0
    try:
        os.makedirs(settings.tmp_root, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix="fx-", dir=settings.tmp_root)
        input_path = os.path.join(workdir, "input.bin")
        try:
            fields, size, part_filename, file_seen = await _receive_form(request, input_path, max_bytes)
        except _TooLarge:
            log.info("render ext=unknown bytes>%d ms=%d result=error:too_large", max_bytes, (time.monotonic() - started) * 1000)
            return JSONResponse(render_error("too_large", f"The file is larger than the limit of {max_bytes} bytes."))
        except _BadForm as exc:
            return _bad_request(str(exc))
        if not file_seen:
            return _bad_request("The form field 'file' is missing.")
        try:
            options = _parse_render_options(fields.get("options"))
        except _BadForm as exc:
            return _bad_request(str(exc))

        filename = fields.get("filename") or part_filename or ""
        ext = _ext_of(filename)
        if ext not in RENDER_EXTENSIONS:
            what = f"Files of type .{ext}" if ext else "Files without an extension"
            result = render_error("unsupported", f"{what} cannot be shown as a picture; PDF and image files can.")
        elif size == 0:
            result = render_error("damaged", "The file is empty.")
        else:
            typed_path = os.path.join(workdir, f"input.{ext}")
            os.replace(input_path, typed_path)
            timeout = settings.timeout_seconds if size <= settings.large_input_bytes else settings.large_timeout_seconds
            spec = {
                "kind": "render",
                "path": typed_path,
                "ext": ext,
                "workdir": workdir,
                "page": options["page"],
                "maxPx": options["maxPx"],
                "timeout": timeout,
                "memoryMb": settings.child_memory_mb,
            }
            result = await run_job(spec, timeout)
            if not result.get("ok"):
                error = result.get("error") or {}
                result = render_error(error.get("kind", "damaged"), error.get("message") or "The file could not be shown.")

        kind = "ok" if result.get("ok") else "error:" + (result.get("error") or {}).get("kind", "unknown")
        log.info("render ext=%s bytes=%d ms=%d result=%s", _log_ext(ext), size, (time.monotonic() - started) * 1000, kind)
        return JSONResponse(result)
    finally:
        slots.release()
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)
