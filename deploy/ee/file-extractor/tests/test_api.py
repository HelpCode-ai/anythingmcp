# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""HTTP contract, authentication, limits and hostile-input guards."""

from __future__ import annotations

import multiprocessing
import os
import threading
import time

import pytest

from tests import samples
from tests.conftest import TOKEN, all_text, failed, ok, post


def _slow_html() -> bytes:
    """16 MB of tag soup: several seconds of pure-Python HTML parsing."""
    return b"<div><span>a</span><b>b</b><i>c</i></div>" * 400_000


# -- endpoints and auth ----------------------------------------------------------

def test_health_needs_no_token(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["version"] == "1"
    assert isinstance(body["ocr"], bool)


def test_formats(client):
    response = client.get("/formats")
    assert response.status_code == 200
    formats = response.json()
    for ext in (".pdf", ".xlsx", ".xlsm", ".xls", ".ods", ".csv", ".tsv", ".docx", ".doc",
                ".odt", ".odp", ".pptx", ".ppt", ".rtf", ".txt", ".md", ".json", ".xml",
                ".log", ".html", ".htm", ".msg", ".eml",
                ".docm", ".dotx", ".xltx", ".xlsb", ".pptm", ".ppsx", ".potx", ".ott", ".ots",
                ".otp", ".epub", ".xps", ".oxps", ".svg", ".dxf", ".mbox", ".pages", ".numbers",
                ".key", ".yaml", ".sql", ".py", ".ts", ".cs"):
        assert ext in formats
    assert ".dwg" not in formats
    assert len(formats) == len(set(formats))


def test_missing_token_is_401(client):
    response = post(client, "a.txt", b"hello", token=None)
    assert response.status_code == 401


def test_wrong_token_is_401(client):
    response = post(client, "a.txt", b"hello", token="wrong")
    assert response.status_code == 401


def test_unconfigured_token_fails_closed(client, monkeypatch):
    monkeypatch.setenv("EXTRACTOR_TOKEN", "")
    assert post(client, "a.txt", b"hello", token="").status_code == 503
    assert post(client, "a.txt", b"hello", token=TOKEN).status_code == 503


def test_response_shape(client):
    body = ok(post(client, "a.txt", "Hallo Welt".encode()))
    assert set(body) == {"ok", "pages", "meta", "truncated", "ocrPages", "emptyPages", "error"}
    assert set(body["meta"]) == {"title", "author", "pageCount", "sheetCount", "format"}
    assert body["pages"] == [{"page": None, "text": "Hallo Welt"}]
    assert body["meta"]["format"] == "txt"


def test_filename_from_file_part_when_field_missing(client):
    files = {"file": ("notiz.txt", b"aus dem Dateiteil", "text/plain")}
    response = client.post("/extract", files=files, headers={"X-Extractor-Token": TOKEN})
    assert all_text(ok(response)) == "aus dem Dateiteil"


def test_windows_path_filename(client):
    body = ok(post(client, "C:\\Daten\\Ordner.mit.Punkt\\notiz.TXT", b"Windows Pfad"))
    assert body["meta"]["format"] == "txt"


def test_unsupported_extension(client):
    body = failed(post(client, "programm.exe", b"MZ..."), "unsupported")
    assert ".exe" in body["error"]["message"]


def test_no_extension_is_unsupported(client):
    failed(post(client, "README", b"text"), "unsupported")


def test_empty_file(client):
    failed(post(client, "leer.txt", b""), "empty")


def test_whitespace_only_is_empty(client):
    failed(post(client, "leer.txt", b"   \n\n\t  "), "empty")


def test_missing_file_part_is_400(client):
    response = client.post("/extract", data={"filename": "a.txt"},
                           headers={"X-Extractor-Token": TOKEN})
    assert response.status_code == 400


@pytest.mark.parametrize("options", ["not json", "[1,2]", '{"ocr": "yes"}', '{"maxChars": -5}', '{"maxChars": "10"}'])
def test_invalid_options_are_400(client, options):
    files = {"file": ("a.txt", b"hello", "text/plain")}
    response = client.post("/extract", files=files, data={"filename": "a.txt", "options": options},
                           headers={"X-Extractor-Token": TOKEN})
    assert response.status_code == 400


# -- limits ----------------------------------------------------------------------

def test_truncation_flowing_text(client):
    text = ("Wort " * 4000).encode()  # 20,000 characters
    body = ok(post(client, "lang.txt", text, {"maxChars": 1000}))
    assert body["truncated"] is True
    assert sum(len(p["text"]) for p in body["pages"]) <= 1000


def test_truncation_pdf_pages(client):
    pages = [f"Seite {i} " + "Inhalt der Seite mit vielen Woertern. " * 20 for i in range(6)]
    body = ok(post(client, "viel.pdf", samples.pdf(pages), {"maxChars": 1500}))
    assert body["truncated"] is True
    assert sum(len(p["text"]) for p in body["pages"]) <= 1500
    assert body["pages"][0]["page"] == 1


def test_truncation_spreadsheet(client):
    body = ok(post(client, "preise.xlsx", samples.xlsx(big_rows=5000), {"maxChars": 5000}))
    assert body["truncated"] is True
    assert sum(len(p["text"]) for p in body["pages"]) <= 5000


def test_max_chars_is_capped_at_hard_limit(client):
    body = ok(post(client, "a.txt", b"kurz", {"maxChars": 10**12}))
    assert body["truncated"] is False


def test_no_truncation_at_exact_fit(client):
    body = ok(post(client, "a.txt", b"x" * 100, {"maxChars": 100}))
    assert body["truncated"] is False


def test_flowing_text_segments(client):
    paragraphs = [f"Absatz {i}: " + ("Lorem ipsum dolor sit amet, consectetur. " * 12) for i in range(40)]
    body = ok(post(client, "lang.txt", "\n\n".join(paragraphs).encode()))
    assert len(body["pages"]) > 4
    for page in body["pages"]:
        assert page["page"] is None
        assert len(page["text"]) <= 4000
        # Segments end on paragraph boundaries.
        assert page["text"].rstrip().endswith("consectetur.")
    joined = all_text(body)
    assert joined.index("Absatz 0:") < joined.index("Absatz 39:")


def test_single_huge_line_is_split(client):
    body = ok(post(client, "eine-zeile.txt", ("abcdefghij" * 1500).encode()))
    assert all(len(p["text"]) <= 4000 for p in body["pages"])
    assert sum(len(p["text"]) for p in body["pages"]) == 15000


def test_too_large_while_streaming(client, monkeypatch):
    monkeypatch.setenv("MAX_INPUT_BYTES", "1000")
    body = failed(post(client, "gross.txt", b"x" * 5000), "too_large")
    assert "1000" in body["error"]["message"]


def test_too_large_by_content_length(client, monkeypatch):
    monkeypatch.setenv("MAX_INPUT_BYTES", "10")
    failed(post(client, "gross.txt", b"x" * (400 * 1024)), "too_large")


def test_at_limit_is_accepted(client, monkeypatch):
    monkeypatch.setenv("MAX_INPUT_BYTES", "1000")
    ok(post(client, "genau.txt", b"y" * 1000))


# -- hostile ZIP containers -----------------------------------------------------------

def test_zip_bomb_ratio(client):
    body = failed(post(client, "bombe.docx", samples.zip_bomb_ratio()), "corrupt")
    assert "decompression bomb" in body["error"]["message"]


def test_zip_bomb_many_entries(client):
    body = failed(post(client, "viele.xlsx", samples.zip_many_entries()), "corrupt")
    assert "decompression bomb" in body["error"]["message"]


def test_zip_bomb_declared_size(client):
    body = failed(post(client, "riesig.ods", samples.zip_declared_huge()), "corrupt")
    assert "decompression bomb" in body["error"]["message"]


# -- isolation: timeout, crash, concurrency, temp files -------------------------------

def test_timeout_kills_child_and_service_recovers(client, monkeypatch):
    monkeypatch.setenv("TIMEOUT_SECONDS", "0.5")
    started = time.monotonic()
    body = failed(post(client, "riesig.html", _slow_html()), "timeout")
    assert time.monotonic() - started < 15
    assert "0.5" in body["error"]["message"]
    assert multiprocessing.active_children() == []
    monkeypatch.delenv("TIMEOUT_SECONDS")
    assert client.get("/health").json()["ok"] is True
    assert all_text(ok(post(client, "danach.txt", b"noch am Leben"))) == "noch am Leben"


def test_busy_queue_returns_503(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setenv("EXTRACT_CONCURRENCY", "1")
    monkeypatch.setenv("TIMEOUT_SECONDS", "3")
    monkeypatch.setenv("QUEUE_TIMEOUT_SECONDS", "0.3")
    with TestClient(app) as local:
        slow_result = {}

        def slow():
            slow_result["r"] = post(local, "riesig.html", _slow_html())

        thread = threading.Thread(target=slow)
        thread.start()
        time.sleep(0.8)
        busy = post(local, "a.txt", b"hello")
        thread.join()
        assert busy.status_code == 503
        assert slow_result["r"].status_code == 200
        # The slot is free again.
        assert post(local, "a.txt", b"hello").status_code == 200


def test_temp_files_are_removed(client, _isolated_env):
    tmp_root = _isolated_env
    ok(post(client, "a.txt", b"hello"))
    failed(post(client, "kaputt.xlsx", os.urandom(1000)), "corrupt")
    ok(post(client, "anfrage.eml", samples.eml()))
    assert os.listdir(tmp_root) == []


def test_child_does_not_see_token(client, monkeypatch, tmp_path):
    """The token is removed from the child's environment."""
    from app import worker

    spec = {"workdir": str(tmp_path)}
    monkeypatch.setenv("EXTRACTOR_TOKEN", "do-not-leak")
    # Run only the hardening step in a throwaway process.
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_report_env_after_harden, args=(spec, queue))
    proc.start()
    proc.join(30)
    assert queue.get(timeout=5) is None
    assert worker  # imported for clarity


def _report_env_after_harden(spec, queue):
    from app.worker import _harden

    _harden(spec)
    queue.put(os.environ.get("EXTRACTOR_TOKEN"))
