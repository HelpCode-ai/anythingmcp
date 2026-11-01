# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
from __future__ import annotations

import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

TOKEN = "test-token-123"
os.environ["EXTRACTOR_TOKEN"] = TOKEN


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch, tmp_path):
    monkeypatch.setenv("EXTRACTOR_TOKEN", TOKEN)
    tmp_root = tmp_path / "extractor-tmp"
    tmp_root.mkdir()
    monkeypatch.setenv("EXTRACTOR_TMPDIR", str(tmp_root))
    for name in ("MAX_INPUT_BYTES", "TIMEOUT_SECONDS", "LARGE_TIMEOUT_SECONDS",
                 "QUEUE_TIMEOUT_SECONDS", "EXTRACT_CONCURRENCY"):
        monkeypatch.delenv(name, raising=False)
    yield tmp_root


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def post(client, filename: str, data: bytes, options: dict | None = None, *,
         token: str | None = TOKEN, form_filename: bool = True):
    files = {"file": ("upload.bin", data, "application/octet-stream")}
    form = {}
    if form_filename:
        form["filename"] = filename
    if options is not None:
        form["options"] = json.dumps(options)
    headers = {} if token is None else {"X-Extractor-Token": token}
    return client.post("/extract", files=files, data=form, headers=headers)


def ok(response) -> dict:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body
    assert body["error"] is None
    return body


def failed(response, kind: str) -> dict:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False, body
    assert body["pages"] == []
    assert body["error"]["kind"] == kind, body
    assert body["error"]["message"]
    return body


def all_text(body: dict) -> str:
    return "\n".join(page["text"] for page in body["pages"])
