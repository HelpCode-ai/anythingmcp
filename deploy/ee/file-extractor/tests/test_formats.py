# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Every format the service supports, with generated documents."""

from __future__ import annotations

import glob
import os
import shutil

import pytest

from tests import samples
from tests.conftest import all_text, failed, ok, post

SAMPLES_DIR = os.environ.get("EXTRACTOR_SAMPLES_DIR", "")


def _sample_files(ext: str) -> list[str]:
    if not SAMPLES_DIR:
        return []
    return sorted(glob.glob(os.path.join(SAMPLES_DIR, f"*.{ext}")))


# -- PDF ----------------------------------------------------------------------------

def test_pdf_pages_and_meta(client):
    data = samples.pdf([
        "Seite eins mit dem Artikel NT-601 und genug Text fuer den Textlayer.",
        "",
        "Seite drei: Preis 412 Euro, Breite 875 mm, Lieferzeit drei Wochen.",
    ])
    body = ok(post(client, "katalog.pdf", data))
    assert [p["page"] for p in body["pages"]] == [1, 3]
    assert "NT-601" in body["pages"][0]["text"]
    assert "Preis 412" in body["pages"][1]["text"]
    assert body["meta"]["pageCount"] == 3
    assert body["meta"]["format"] == "pdf"
    assert body["meta"]["title"] == "Testdokument"
    assert body["meta"]["author"] == "Einkauf"
    assert body["emptyPages"] == 1
    assert body["ocrPages"] == 0
    assert body["truncated"] is False


def test_pdf_encrypted(client):
    body = failed(post(client, "geheim.pdf", samples.encrypted_pdf()), "encrypted")
    assert "password" in body["error"]["message"].lower()


def test_pdf_corrupt(client):
    failed(post(client, "kaputt.pdf", b"%PDF-1.7\n" + os.urandom(4096)), "corrupt")


def test_pdf_without_text_layer_is_empty(client):
    body = failed(post(client, "scan.pdf", samples.scanned_pdf()), "empty")
    assert body["meta"]["pageCount"] == 1
    assert body["emptyPages"] == 1
    assert "OCR" in body["error"]["message"]


def test_pdf_ocr_request_without_ocr_build_is_processed_without_ocr(client):
    from app.ocr import ocr_available

    if ocr_available():
        pytest.skip("OCR is installed; covered by test_pdf_ocr")
    body = failed(post(client, "scan.pdf", samples.scanned_pdf(), {"ocr": True}), "empty")
    assert body["ocrPages"] == 0


def test_pdf_ocr(client):
    from app.ocr import ocr_available

    if not ocr_available():
        pytest.skip("image built without OCR (build arg OCR=1 adds it)")
    body = ok(post(client, "scan.pdf", samples.scanned_pdf("INVOICE 4711"), {"ocr": True}))
    assert body["ocrPages"] == 1
    assert "4711" in all_text(body)


# -- spreadsheets ---------------------------------------------------------------

def test_xlsx_rows_with_header(client):
    body = ok(post(client, "preise.xlsx", samples.xlsx()))
    text = all_text(body)
    lines = text.split("\n")
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412 · Lieferdatum=2026-03-01' in lines
    assert ('Sheet "Preise" row 3: Artikel=NT-602 · Breite=1000 · Preis=99.5 · '
            "Lieferdatum=2026-03-01T14:30:00 · E=x · Notiz=zwei Zeilen") in lines
    assert 'Sheet "Preise" row 5: Artikel=NT-603 · Breite=750 · Preis=10 · Notiz=TRUE' in lines
    assert 'Sheet "Preise" columns: Artikel · Breite · Preis · Lieferdatum · Notiz' in lines
    assert 'Sheet "Gross" row 451: Nr=A-00450 · Wert=675' in lines
    # Preise (1 segment) + Gross: 451 lines in segments of 200 -> 3 segments.
    assert [p["page"] for p in body["pages"]] == [1, 2, 3, 4]
    assert all(p["text"].startswith('Sheet "Gross"') for p in body["pages"][1:])
    assert body["meta"]["sheetCount"] == 3
    assert body["meta"]["title"] == "Preisliste 2026"
    assert body["meta"]["author"] == "Einkauf"
    assert body["meta"]["format"] == "xlsx"


def test_xlsm_is_read_like_xlsx(client):
    body = ok(post(client, "makro.xlsm", samples.xlsx(big_rows=0)))
    assert "Artikel=NT-601" in all_text(body)


def test_xlsx_corrupt_random_bytes(client):
    failed(post(client, "kaputt.xlsx", os.urandom(8192)), "corrupt")


def test_xlsx_zip_without_workbook(client):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("hello.txt", "not a workbook")
    failed(post(client, "leer.xlsx", buf.getvalue()), "corrupt")


def test_xls(client):
    body = ok(post(client, "alt.xls", samples.xls()))
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412 · Lieferdatum=2026-03-01' in all_text(body)
    assert body["meta"]["sheetCount"] == 1


def test_xls_that_is_really_html(client):
    body = ok(post(client, "export.xls", b"<html><body><table><tr><td>NT-601</td><td>412</td></tr></table></body></html>"))
    assert "NT-601 · 412" in all_text(body)


def test_ods_rows_and_repeats(client):
    body = ok(post(client, "preise.ods", samples.ods()))
    text = all_text(body)
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412' in text
    # 1,048,570 repeated empty rows are counted, not expanded.
    assert 'Sheet "Preise" row 1048573: Artikel=NT-602 · D=TRUE · Datum=2026-03-01' in text
    assert body["meta"]["sheetCount"] == 1
    assert body["meta"]["title"] == "ODF Titel"


def test_csv_semicolon_cp1252(client):
    body = ok(post(client, "preise.csv", samples.csv_semicolon_cp1252()))
    text = all_text(body)
    assert 'Sheet "preise" row 2: Artikel=NT-601 · Bezeichnung=Türblatt weiß · Preis=412,00' in text
    assert body["pages"][0]["page"] == 1
    assert body["meta"]["sheetCount"] == 1


def test_tsv(client):
    body = ok(post(client, "liste.tsv", samples.tsv()))
    assert 'Sheet "liste" row 2: Artikel=NT-601 · Preis=412' in all_text(body)


# -- documents ------------------------------------------------------------------

def test_docx_paragraphs_and_tables(client):
    body = ok(post(client, "angebot.docx", samples.docx()))
    text = all_text(body)
    assert "Angebot 2026" in text
    assert "Artikel · Breite · Preis" in text
    assert "NT-601 · 875 · 412" in text
    assert text.index("Artikel · Breite") < text.index("Mit freundlichen Grüßen")
    assert all(p["page"] is None for p in body["pages"])
    assert body["meta"]["title"] == "Angebot"
    assert body["meta"]["author"] == "Vertrieb"


def test_docx_long_document_is_segmented(client):
    body = ok(post(client, "lang.docx", samples.docx(paragraphs=60)))
    assert len(body["pages"]) > 3
    assert all(p["page"] is None and len(p["text"]) <= 4000 for p in body["pages"])
    text = all_text(body)
    assert "Absatz 0:" in text and "Absatz 59:" in text


def test_docx_ole_encrypted(client):
    failed(post(client, "geheim.docx", samples.ole_encrypted_ooxml()), "encrypted")


def test_xlsx_ole_encrypted(client):
    failed(post(client, "geheim.xlsx", samples.ole_encrypted_ooxml()), "encrypted")


def test_pptx_slides(client):
    body = ok(post(client, "schulung.pptx", samples.pptx()))
    pages = body["pages"]
    assert [p["page"] for p in pages] == [1, 2]
    assert pages[0]["text"].startswith("Willkommen")
    assert "Erste Folie" in pages[0]["text"]
    assert "Notes: Sprechernotiz" in pages[0]["text"]
    assert pages[1]["text"].startswith("Preise")
    assert "NT-601 · 412" in pages[1]["text"]
    assert body["meta"]["pageCount"] == 2
    assert body["meta"]["title"] == "Schulung"


def test_odt(client):
    body = ok(post(client, "brief.odt", samples.odt()))
    text = all_text(body)
    assert "Überschrift" in text
    assert "Hallo  Welt\tTab" in text
    assert "A1 · B1" in text
    assert "Ende mit Span danach" in text
    assert body["meta"]["author"] == "Autorin"


def test_odt_encrypted(client):
    failed(post(client, "geheim.odt", samples.odt(encrypted=True)), "encrypted")


def test_odp_slides(client):
    body = ok(post(client, "folien.odp", samples.odp()))
    assert body["pages"] == [
        {"page": 1, "text": "Folie eins\nNotes: Notiz eins"},
        {"page": 2, "text": "Folie zwei"},
    ]
    assert body["meta"]["pageCount"] == 2


def test_rtf(client):
    body = ok(post(client, "brief.rtf", samples.rtf()))
    text = all_text(body)
    assert "Grüße aus RTF" in text
    assert "Zweite Zeile" in text


@pytest.mark.parametrize("ext", ["txt", "md", "log"])
def test_plain_text_latin1(client, ext):
    body = ok(post(client, f"notiz.{ext}", samples.text_latin1()))
    assert "Größenangaben für Türen" in all_text(body)
    assert body["pages"][0]["page"] is None


def test_json_is_text(client):
    body = ok(post(client, "daten.json", '{"artikel": "NT-601", "preis": 412}'.encode()))
    assert '"artikel": "NT-601"' in all_text(body)


def test_xml_is_never_parsed(client):
    body = ok(post(client, "bombe.xml", samples.xml_entity_bomb()))
    text = all_text(body)
    assert "&lol3;" in text
    assert "lollollol" not in text


def test_utf8_bom_text(client):
    body = ok(post(client, "bom.txt", "﻿Ärger mit Umlauten".encode("utf-8")))
    assert all_text(body) == "Ärger mit Umlauten"


@pytest.mark.parametrize("ext", ["html", "htm"])
def test_html(client, ext):
    body = ok(post(client, f"seite.{ext}", samples.html()))
    text = all_text(body)
    assert "Preise" in text
    assert "Erster Absatz & mehr." in text
    assert "Artikel · Preis" in text
    assert "NT-601 · 412" in text
    assert "SCRIPT-CONTENT" not in text
    assert "color:red" not in text
    assert body["meta"]["title"] == "Preis Seite"


# -- mail -------------------------------------------------------------------------

def test_eml_with_attachments(client):
    body = ok(post(client, "anfrage.eml", samples.eml()))
    text = all_text(body)
    assert "From: Anna Beispiel <anna@example.com>" in text
    assert "To: Einkauf <einkauf@example.com>" in text
    assert "Cc: Chef <chef@example.com>" in text
    assert "Subject: Preisanfrage Türen" in text
    assert "Date: Mon, 02 Mar 2026 10:00:00 +0100" in text
    assert "bitte Preise für NT-601 prüfen" in text
    assert "HTML-Version" not in text  # plain body preferred
    assert "--- Attachment: preise.csv ---" in text
    assert 'Sheet "preise" row 2: Artikel=NT-601 · Bezeichnung=Türblatt weiß' in text
    assert "--- Attachment: angebot.docx ---" in text
    assert "NT-601 · 875 · 412" in text
    assert "--- Attachment: tool.exe ---" not in text
    assert "NESTED-BODY-SHOULD-NOT-APPEAR" not in text
    assert "Attachments: preise.csv, angebot.docx, tool.exe, weitergeleitet.eml" in text
    assert text.index("Subject:") < text.index("bitte Preise") < text.index("--- Attachment: preise.csv")
    assert body["meta"]["title"] == "Preisanfrage Türen"
    assert all(p["page"] is None for p in body["pages"])


def test_eml_signed(client):
    body = ok(post(client, "signiert.eml", samples.eml_signed()))
    text = all_text(body)
    assert "Signierter Text mit Inhalt." in text
    assert "Subject: Signierte Nachricht" in text


def test_eml_garbage_does_not_crash(client):
    response = post(client, "kaputt.eml", os.urandom(4096))
    assert response.status_code == 200
    assert response.json()["ok"] in (True, False)


def test_msg_samples(client):
    files = _sample_files("msg")
    if not files:
        pytest.skip("no .msg sample: set EXTRACTOR_SAMPLES_DIR to a folder with *.msg files "
                    "(no MSG writer is available to generate one)")
    for path in files:
        with open(path, "rb") as fh:
            response = post(client, os.path.basename(path), fh.read())
        assert response.status_code == 200
        body = response.json()
        assert body["ok"], (path, body)
        assert "Subject:" in all_text(body) or "From:" in all_text(body), path


def test_msg_garbage_is_corrupt(client):
    failed(post(client, "kaputt.msg", os.urandom(4096)), "corrupt")


@pytest.mark.parametrize("ext,tool", [("doc", "antiword"), ("ppt", "catppt"), ("xls", None)])
def test_legacy_office_samples(client, ext, tool):
    files = _sample_files(ext)
    if not files:
        pytest.skip(f"no .{ext} sample: set EXTRACTOR_SAMPLES_DIR (no free .{ext} writer to generate one)")
    if tool and shutil.which(tool) is None:
        pytest.skip(f"{tool} is not installed (it is in the container image)")
    for path in files:
        with open(path, "rb") as fh:
            body = ok(post(client, os.path.basename(path), fh.read()))
        assert len(all_text(body)) > 20, path


@pytest.mark.parametrize("ext", ["doc", "ppt"])
def test_legacy_office_garbage_is_corrupt(client, ext):
    if shutil.which("antiword") is None:
        pytest.skip("antiword/catdoc are not installed (they are in the container image)")
    failed(post(client, f"kaputt.{ext}", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + os.urandom(4096)), "corrupt")


def test_doc_that_is_really_rtf(client):
    body = ok(post(client, "brief.doc", samples.rtf()))
    assert "Grüße aus RTF" in all_text(body)


def test_doc_that_is_really_docx(client):
    body = ok(post(client, "angebot.doc", samples.docx()))
    assert "NT-601 · 875 · 412" in all_text(body)
