# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""POST /render: one PDF page or an image as a JPEG."""

from __future__ import annotations

import base64
import io
import json
import struct
import zlib

import pytest

from tests import samples
from tests.conftest import TOKEN


def render(client, filename: str, data: bytes, options: dict | None = None, *, token: str | None = TOKEN):
    files = {"file": ("upload.bin", data, "application/octet-stream")}
    form = {"filename": filename}
    if options is not None:
        form["options"] = json.dumps(options)
    headers = {} if token is None else {"X-Extractor-Token": token}
    return client.post("/render", files=files, data=form, headers=headers)


def ok_picture(response) -> tuple[dict, "object"]:
    from PIL import Image

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body
    assert body["mimeType"] == "image/jpeg"
    raw = base64.b64decode(body["base64"])
    image = Image.open(io.BytesIO(raw))
    assert image.format == "JPEG"
    assert image.size == (body["width"], body["height"])
    return body, image


def failed(response, kind: str) -> dict:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False, body
    assert body["error"]["kind"] == kind, body
    assert body["error"]["message"]
    assert "base64" not in body
    return body


def image_bytes(fmt: str, size=(1200, 800), mode="RGB", **save) -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new(mode, size, "white" if mode in ("RGB", "RGBA") else 255)
    if mode in ("RGB", "RGBA"):
        ImageDraw.Draw(image).rectangle([10, 10, size[0] // 2, size[1] // 2], fill=(200, 30, 30))
    buf = io.BytesIO()
    image.save(buf, format=fmt, **save)
    return buf.getvalue()


def png_bomb(width: int = 100_000, height: int = 100_000) -> bytes:
    """A tiny PNG whose header declares 10 billion pixels."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00" * 64)) + chunk(b"IEND", b"")


def noise_png(size: int = 2400) -> bytes:
    import random

    from PIL import Image

    rng = random.Random(7)
    image = Image.frombytes("RGB", (size, size), bytes(rng.getrandbits(8) for _ in range(size * size * 3)))
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


# -- PDF ----------------------------------------------------------------------------

def test_pdf_page_is_rendered_within_max_px(client):
    data = samples.pdf(["Seite eins mit Text.", "Seite zwei mit Text.", "Seite drei."])
    body, image = ok_picture(render(client, "plan.pdf", data, {"page": 2, "maxPx": 800}))
    assert body["page"] == 2
    assert body["pageCount"] == 3
    assert max(image.size) == 800  # A4 portrait: the height is the longest side
    assert image.size[0] < image.size[1]


def test_pdf_default_page_and_size(client):
    body, image = ok_picture(render(client, "plan.pdf", samples.pdf(["Eine Seite."])))
    assert body["page"] == 1 and body["pageCount"] == 1
    assert max(image.size) == 1600


def test_pdf_max_px_is_capped(client):
    _body, image = ok_picture(render(client, "plan.pdf", samples.pdf(["Eine Seite."]), {"maxPx": 10_000}))
    assert max(image.size) == 2400


def test_pdf_page_out_of_range(client):
    body = failed(render(client, "plan.pdf", samples.pdf(["a", "b"]), {"page": 3}), "page_out_of_range")
    assert "2 pages" in body["error"]["message"]


def test_pdf_encrypted(client):
    failed(render(client, "geheim.pdf", samples.encrypted_pdf()), "encrypted")


def test_pdf_damaged(client):
    failed(render(client, "kaputt.pdf", b"%PDF-1.4 not really a pdf"), "damaged")


# -- images -------------------------------------------------------------------------

@pytest.mark.parametrize("ext,fmt", [("png", "PNG"), ("jpg", "JPEG"), ("jpeg", "JPEG"), ("gif", "GIF"),
                                     ("webp", "WEBP"), ("tif", "TIFF"), ("tiff", "TIFF"), ("bmp", "BMP")])
def test_images_are_downscaled_to_jpeg(client, ext, fmt):
    body, image = ok_picture(render(client, f"foto.{ext}", image_bytes(fmt), {"maxPx": 600}))
    assert image.size == (600, 400)
    assert body["page"] == 1 and body["pageCount"] == 1
    # The red rectangle survives the conversion (top-left quarter).
    r, g, b = image.convert("RGB").getpixel((100, 100))
    assert r > 150 and g < 100 and b < 100


def test_small_image_is_not_upscaled(client):
    _body, image = ok_picture(render(client, "icon.png", image_bytes("PNG", size=(120, 80))))
    assert image.size == (120, 80)


def test_transparent_png_on_white(client):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", (50, 50), (0, 0, 0, 0)).save(buf, format="PNG")
    _body, image = ok_picture(render(client, "transparent.png", buf.getvalue()))
    assert image.convert("RGB").getpixel((25, 25)) == (255, 255, 255)


def test_16_bit_greyscale_png(client):
    from PIL import Image

    image = Image.new("I;16", (64, 64), 1000)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    ok_picture(render(client, "scan.png", buf.getvalue()))


def test_mislabelled_image_is_still_shown(client):
    ok_picture(render(client, "foto.jpg", image_bytes("PNG")))


def test_multipage_tiff_pages(client):
    from PIL import Image

    frames = [Image.new("RGB", (300, 200), colour) for colour in ("white", "black", "white")]
    buf = io.BytesIO()
    frames[0].save(buf, format="TIFF", save_all=True, append_images=frames[1:])
    data = buf.getvalue()
    body, image = ok_picture(render(client, "fax.tif", data, {"page": 2}))
    assert body["pageCount"] == 3 and body["page"] == 2
    assert image.convert("L").getpixel((150, 100)) < 30
    failed(render(client, "fax.tif", data, {"page": 4}), "page_out_of_range")


def test_animated_gif_shows_first_frame_only(client):
    from PIL import Image

    frames = [Image.new("RGB", (40, 40), colour) for colour in ("white", "black")]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:])
    body, image = ok_picture(render(client, "anim.gif", buf.getvalue()))
    assert body["pageCount"] == 1
    assert image.convert("L").getpixel((20, 20)) > 220
    failed(render(client, "anim.gif", buf.getvalue(), {"page": 2}), "page_out_of_range")


def test_decompression_bomb_is_refused_before_decoding(client):
    body = failed(render(client, "bombe.png", png_bomb()), "too_large")
    assert "pixels" in body["error"]["message"] or "bomb" in body["error"]["message"]


def test_damaged_image(client):
    failed(render(client, "kaputt.png", b"\x89PNG\r\n\x1a\nnot an image"), "damaged")


def test_eps_disguised_as_image_is_not_decoded(client):
    eps = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n"
    failed(render(client, "foto.png", eps), "damaged")


def test_output_is_capped(client):
    from app.render import MAX_OUTPUT_BYTES

    body, _image = ok_picture(render(client, "rauschen.png", noise_png(), {"maxPx": 2400}))
    assert len(base64.b64decode(body["base64"])) <= MAX_OUTPUT_BYTES


# -- request handling ---------------------------------------------------------------

def test_unsupported_type(client):
    body = failed(render(client, "angebot.docx", samples.docx()), "unsupported")
    assert "PDF and image" in body["error"]["message"]


def test_empty_file(client):
    failed(render(client, "leer.pdf", b""), "damaged")


def test_wrong_token_is_401(client):
    assert render(client, "plan.pdf", samples.pdf(["a"]), token="wrong").status_code == 401
    assert render(client, "plan.pdf", samples.pdf(["a"]), token=None).status_code == 401


@pytest.mark.parametrize("options", [{"page": 0}, {"page": "2"}, {"page": True}, {"maxPx": 10}, [1]])
def test_invalid_options_are_400(client, options):
    assert render(client, "plan.pdf", samples.pdf(["a"]), options).status_code == 400


def test_too_large_upload(client, monkeypatch):
    monkeypatch.setenv("MAX_INPUT_BYTES", "1000")
    failed(render(client, "foto.png", image_bytes("PNG") + b"\x00" * 5000), "too_large")


def test_render_timeout(client, monkeypatch):
    monkeypatch.setenv("TIMEOUT_SECONDS", "0.001")
    failed(render(client, "plan.pdf", samples.pdf(["a"])), "timeout")


def test_render_temp_files_are_removed(client, _isolated_env):
    ok_picture(render(client, "plan.pdf", samples.pdf(["a"])))
    assert list(_isolated_env.iterdir()) == []
