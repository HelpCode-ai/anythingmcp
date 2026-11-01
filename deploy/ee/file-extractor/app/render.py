# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""One page of a PDF, or an image file, as a JPEG picture (``POST /render``).

Runs in the same isolated child process as an extraction. The output is a
downscaled JPEG: the longest side at most ``maxPx`` pixels and the encoded
picture at most ``MAX_OUTPUT_BYTES`` (quality, then size, is lowered until
it fits). Images are opened only with a fixed set of common decoders, and
their declared pixel count is checked before any pixel is decoded.
"""

from __future__ import annotations

import base64
import io

from .errors import ExtractError

DEFAULT_MAX_PX = 1600
HARD_MAX_PX = 2400
MIN_MAX_PX = 64
MAX_OUTPUT_BYTES = 1_500_000
# Largest image (in pixels, all frames counted once) that is decoded at all.
MAX_SOURCE_PIXELS = 100_000_000
# PDF pages are rendered at most this many times their size in points
# (8 = 576 dpi), so a tiny page is not blown up into a huge bitmap.
MAX_PDF_SCALE = 8.0
JPEG_QUALITIES = (80, 65, 50)

IMAGE_EXTENSIONS = ("png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp")
# The only Pillow decoders ever used, whatever the extension says (a ".jpg"
# that is really a PNG is common); exotic plugins (EPS via Ghostscript, ...)
# are never reached.
SAFE_DECODERS = ("PNG", "JPEG", "GIF", "WEBP", "TIFF", "BMP", "DIB")
RENDER_EXTENSIONS = ("pdf", *IMAGE_EXTENSIONS)
# Formats whose frames are pages (multi-page scans); in GIF and WebP the
# frames are an animation, and only the first is shown.
_PAGED_IMAGE_FORMATS = {"TIFF"}


def _to_rgb(image):
    from PIL import Image

    if image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    if image.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        # 16/32-bit greyscale (scans, technical images): scale to 8 bits.
        image = image.convert("I")
        low, high = image.getextrema()
        if high > low:
            image = image.point(lambda v: (v - low) * 255 / (high - low))
        return image.convert("L").convert("RGB")
    return image.convert("RGB") if image.mode != "RGB" else image


def _encode(image) -> tuple[bytes, int, int]:
    """JPEG within MAX_OUTPUT_BYTES: lower the quality first, then the size."""
    from PIL import Image

    while True:
        for quality in JPEG_QUALITIES:
            buf = io.BytesIO()
            image.save(buf, format="JPEG", quality=quality, optimize=True)
            if buf.tell() <= MAX_OUTPUT_BYTES:
                return buf.getvalue(), image.width, image.height
        if max(image.size) <= MIN_MAX_PX:
            raise ExtractError("too_large", "The picture cannot be made small enough.")
        image = image.resize((max(1, int(image.width * 0.75)), max(1, int(image.height * 0.75))), Image.LANCZOS)


def _result(data: bytes, width: int, height: int, page: int, page_count: int) -> dict:
    return {
        "ok": True,
        "mimeType": "image/jpeg",
        "base64": base64.b64encode(data).decode("ascii"),
        "width": width,
        "height": height,
        "page": page,
        "pageCount": page_count,
        "error": None,
    }


def _out_of_range(page: int, page_count: int) -> ExtractError:
    noun = "page" if page_count == 1 else "pages"
    return ExtractError("page_out_of_range", f"Page {page} does not exist; the file has {page_count} {noun}.")


def render_pdf(path: str, page: int, max_px: int) -> dict:
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ExtractError("encrypted", "The PDF is password-protected.") from None
        raise ExtractError("damaged", "The file is not a readable PDF.") from None
    try:
        page_count = len(doc)
        if page_count < 1:
            raise ExtractError("damaged", "The PDF has no pages.")
        if page > page_count:
            raise _out_of_range(page, page_count)
        pdf_page = doc[page - 1]
        try:
            width, height = pdf_page.get_size()
            longest = max(width, height)
            if not longest or longest <= 0 or longest != longest:  # zero, negative or NaN
                raise ExtractError("damaged", "The PDF page has no size.")
            scale = min(max_px / longest, MAX_PDF_SCALE)
            bitmap = pdf_page.render(scale=scale, draw_annots=True)
            try:
                image = bitmap.to_pil()
            finally:
                bitmap.close()
        finally:
            pdf_page.close()
    finally:
        doc.close()
    data, w, h = _encode(_to_rgb(image))
    return _result(data, w, h, page, page_count)


def render_image(path: str, ext: str, page: int, max_px: int) -> dict:
    import warnings

    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS
    label = ext.upper()
    try:
        with warnings.catch_warnings():
            # Above MAX_IMAGE_PIXELS Pillow only warns (it errors at twice
            # that); treat the warning as the error it is here.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(path, formats=SAFE_DECODERS)
            width, height = image.size
            if width < 1 or height < 1:
                raise ExtractError("damaged", f"The {label} image has no size.")
            if width * height > MAX_SOURCE_PIXELS:
                raise ExtractError("too_large", f"The image has {width} x {height} pixels; at most {MAX_SOURCE_PIXELS:,} are shown.")
            page_count = 1
            if image.format in _PAGED_IMAGE_FORMATS:
                page_count = max(1, int(getattr(image, "n_frames", 1) or 1))
            if page > page_count:
                raise _out_of_range(page, page_count)
            if page > 1:
                image.seek(page - 1)
                width, height = image.size
                if width * height > MAX_SOURCE_PIXELS:
                    raise ExtractError("too_large", f"The page has {width} x {height} pixels; at most {MAX_SOURCE_PIXELS:,} are shown.")
            # JPEG can decode at 1/2, 1/4 or 1/8 size directly.
            image.draft("RGB", (max_px, max_px))
            image.load()
    except ExtractError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ExtractError("too_large", "The image is too large to show (it looks like a decompression bomb).") from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError):
        raise ExtractError("damaged", f"The file is not a readable {label} image.") from None
    try:
        image = ImageOps.exif_transpose(image) or image
    except Exception:
        pass  # a broken orientation tag does not stop the picture
    image = _to_rgb(image)
    image.thumbnail((max_px, max_px), Image.LANCZOS)
    data, w, h = _encode(image)
    return _result(data, w, h, page, page_count)


def render_to_result(spec: dict) -> dict:
    ext = spec["ext"]
    page = int(spec.get("page") or 1)
    max_px = max(MIN_MAX_PX, min(int(spec.get("maxPx") or DEFAULT_MAX_PX), HARD_MAX_PX))
    if ext == "pdf":
        return render_pdf(spec["path"], page, max_px)
    if ext in IMAGE_EXTENSIONS:
        return render_image(spec["path"], ext, page, max_px)
    raise ExtractError("unsupported", f"Files of type .{ext} cannot be shown as a picture." if ext else "Files without an extension cannot be shown as a picture.")
