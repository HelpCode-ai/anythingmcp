# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Formats added after the first release: text family, Office variants,
xlsb, SVG, DXF, EPUB, XPS, iWork previews, mbox."""

from __future__ import annotations

import pytest

from app.formats import SOURCE_FORMATS
from tests import samples
from tests.conftest import all_text, failed, ok, post

# -- plain text family ------------------------------------------------------------


@pytest.mark.parametrize("ext", SOURCE_FORMATS)
def test_source_and_config_files_are_text(client, ext):
    data = "# Größe für NT-601\nkey = value 412\n".encode("utf-8")
    body = ok(post(client, f"datei.{ext}", data))
    text = all_text(body)
    assert "Größe für NT-601" in text
    assert "key = value 412" in text
    assert body["pages"][0]["page"] is None


def test_source_latin1(client):
    body = ok(post(client, "config.ini", samples.text_latin1()))
    assert "Größenangaben für Türen" in all_text(body)


def test_source_utf16_without_bom(client):
    body = ok(post(client, "script.ps1", "Write-Host 'Türen NT-601'\n".encode("utf-16-le")))
    assert "Write-Host 'Türen NT-601'" in all_text(body)


def test_binary_ts_video_is_unsupported(client):
    # An MPEG transport stream shares the .ts extension with TypeScript.
    import random

    rng = random.Random(4711)
    data = b"".join(b"\x47\x40\x00\x10" + bytes(rng.randrange(256) for _ in range(184)) for _ in range(50))
    body = failed(post(client, "aufnahme.ts", data), "unsupported")
    assert "binary" in body["error"]["message"]


@pytest.mark.parametrize("ext", ["kml", "gpx"])
def test_xml_based_text_formats_are_never_parsed(client, ext):
    body = ok(post(client, f"route.{ext}", samples.xml_entity_bomb()))
    text = all_text(body)
    assert "&lol3;" in text
    assert "lollollol" not in text


def test_source_truncation(client):
    data = ("x = 1\n" * 2000).encode()
    body = ok(post(client, "gross.py", data, {"maxChars": 100}))
    assert body["truncated"] is True
    assert len(all_text(body)) <= 100


# -- Office variants ----------------------------------------------------------------


@pytest.mark.parametrize("ext", ["docm", "dotx", "dotm"])
def test_word_variants(client, ext):
    body = ok(post(client, f"vorlage.{ext}", samples.office_variant(ext)))
    text = all_text(body)
    assert "Angebot 2026" in text
    assert "NT-601 · 875 · 412" in text
    assert body["meta"]["title"] == "Angebot"


@pytest.mark.parametrize("ext", ["xltx", "xltm"])
def test_excel_templates(client, ext):
    body = ok(post(client, f"vorlage.{ext}", samples.office_variant(ext)))
    lines = all_text(body).split("\n")
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412 · Lieferdatum=2026-03-01' in lines


@pytest.mark.parametrize("ext", ["pptm", "ppsx", "ppsm", "potx", "potm"])
def test_powerpoint_variants(client, ext):
    body = ok(post(client, f"folien.{ext}", samples.office_variant(ext)))
    assert [p["page"] for p in body["pages"]] == [1, 2]
    assert "Willkommen" in body["pages"][0]["text"]
    assert "NT-601 · 412" in body["pages"][1]["text"]


@pytest.mark.parametrize("ext", ["docm", "xltx", "ppsx", "xlsb", "epub", "xps", "pages"])
def test_zip_variants_go_through_the_bomb_guard(client, ext):
    body = failed(post(client, f"bombe.{ext}", samples.zip_bomb_ratio()), "corrupt")
    assert "decompression bomb" in body["error"]["message"]


@pytest.mark.parametrize("ext", ["dotm", "xltm", "potx", "xlsb"])
def test_ole_encrypted_variants(client, ext):
    failed(post(client, f"geheim.{ext}", samples.ole_encrypted_ooxml()), "encrypted")


def test_word_variant_that_is_a_workbook_is_corrupt(client):
    failed(post(client, "falsch.docm", samples.xlsx(big_rows=3)), "corrupt")


def test_powerpoint_variant_that_is_a_document_is_corrupt(client):
    failed(post(client, "falsch.ppsx", samples.docx()), "corrupt")


@pytest.mark.parametrize("ext", ["ott", "ots", "otp"])
def test_opendocument_templates(client, ext):
    body = ok(post(client, f"vorlage.{ext}", samples.odf_template(ext)))
    text = all_text(body)
    expected = {"ott": "A1 · B1", "ots": "Artikel=NT-601", "otp": "Folie zwei"}[ext]
    assert expected in text


# -- xlsb --------------------------------------------------------------------------


def test_xlsb_rows_with_header(client):
    body = ok(post(client, "preise.xlsb", samples.xlsb()))
    lines = all_text(body).split("\n")
    assert 'Sheet "Preise" columns: Artikel · Breite · Preis' in lines
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412' in lines
    assert 'Sheet "Preise" row 3: Artikel=NT-602 · Breite=1000 · Preis=99.5' in lines
    assert body["meta"]["sheetCount"] == 1


def test_xlsb_huge_declared_dimension_is_not_expanded(client):
    body = ok(post(client, "preise.xlsb", samples.xlsb(huge_dimension=True)))
    assert 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412' in all_text(body)


def test_xlsb_without_workbook_is_corrupt(client):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
    failed(post(client, "leer.xlsb", buf.getvalue()), "corrupt")


# -- SVG ---------------------------------------------------------------------------


def test_svg_text(client):
    body = ok(post(client, "plan.svg", samples.svg()))
    text = all_text(body)
    assert "Grundriss EG" in text
    assert "Erdgeschoss mit Tueren" in text
    assert "Tür NT-601 links" in text
    assert "Zeile eins\nZeile zwei" in text
    assert "STYLE-CONTENT" not in text
    assert "SCRIPT-CONTENT" not in text
    assert body["meta"]["title"] == "Grundriss EG"


def test_svg_illustrator_internal_entities(client):
    assert "Illustrator Text" in all_text(ok(post(client, "logo.svg", samples.svg_illustrator())))


def test_svg_external_entity_is_never_resolved(client, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP-SECRET-CONTENT")
    response = post(client, "xxe.svg", samples.svg_xxe(str(secret)))
    assert "TOP-SECRET-CONTENT" not in response.text
    assert "root:" not in response.text
    failed(response, "corrupt")


def test_svg_external_parameter_entity_is_never_fetched(client):
    # expat never loads external parameter entities (or external DTDs); the
    # declaration is skipped and the visible text is read.
    body = ok(post(client, "xxe.svg", samples.svg_parameter_xxe()))
    assert all_text(body) == "Hallo"


def test_svg_entity_bomb_is_stopped(client):
    response = post(client, "bombe.svg", samples.svg_entity_bomb())
    body = failed(response, "corrupt")
    assert "lollollol" not in response.text
    assert body["pages"] == []


def test_svg_garbage_is_corrupt(client):
    failed(post(client, "kaputt.svg", b"<svg><text>offen"), "corrupt")


# -- DXF ---------------------------------------------------------------------------


def test_dxf_text_entities(client):
    body = ok(post(client, "zeichnung.dxf", samples.dxf()))
    text = all_text(body)
    assert "Tür NT-601 ⌀80 ±0.5" in text
    assert "Erste Zeile\nZweite Zeile 1/2 Ø 30" in text
    assert "TITEL: Grundriss EG" in text
    assert "Arial" not in text
    assert "\\P" not in text


def test_dxf_binary_is_unsupported(client):
    body = failed(post(client, "zeichnung.dxf", samples.dxf_binary()), "unsupported")
    assert "ASCII DXF" in body["error"]["message"]


def test_dxf_garbage_is_corrupt(client):
    failed(post(client, "zeichnung.dxf", b"this is not a drawing\nat all\n"), "corrupt")


def test_dwg_is_unsupported_with_hint(client):
    body = failed(post(client, "zeichnung.dwg", b"AC1032\x00\x00binary"), "unsupported")
    assert "DXF" in body["error"]["message"]


# -- EPUB --------------------------------------------------------------------------


def test_epub_chapters_in_spine_order(client):
    body = ok(post(client, "anleitung.epub", samples.epub()))
    assert [p["page"] for p in body["pages"]] == [1, 3]
    assert "Kapitel eins" in body["pages"][0]["text"]
    assert "Zarge NT-601 montieren." in body["pages"][0]["text"]
    assert "Türblatt einhängen." in body["pages"][1]["text"]
    assert body["meta"]["title"] == "Montageanleitung"
    assert body["meta"]["author"] == "Technik"
    assert body["meta"]["pageCount"] == 3


def test_epub_drm_is_encrypted(client):
    failed(post(client, "geschuetzt.epub", samples.epub(drm=True)), "encrypted")


def test_epub_chapter_external_entity_is_never_resolved(client):
    response = post(client, "xxe.epub", samples.epub(xxe=True))
    body = ok(response)
    assert "root:" not in response.text
    assert "&xxe;" in all_text(body)


def test_epub_without_package_is_corrupt(client):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
    failed(post(client, "leer.epub", buf.getvalue()), "corrupt")


# -- XPS ---------------------------------------------------------------------------


@pytest.mark.parametrize("ext,openxps", [("xps", False), ("oxps", True)])
def test_xps_pages_in_document_order(client, ext, openxps):
    body = ok(post(client, f"lieferschein.{ext}", samples.xps(openxps=openxps)))
    assert [p["page"] for p in body["pages"]] == [1, 2]
    assert body["pages"][0]["text"] == "Lieferschein Nr. 4711\n{Artikel} NT-601"
    assert body["pages"][1]["text"] == "Seite zwei"
    assert body["meta"]["pageCount"] == 2


def test_xps_external_entity_is_never_resolved(client):
    response = post(client, "xxe.xps", samples.xps(xxe=True))
    assert "root:" not in response.text
    body = response.json()
    # The page with the DTD is refused; the other page is still read.
    assert all_text(body) == "Seite zwei"


# -- iWork -------------------------------------------------------------------------


@pytest.mark.parametrize("ext", ["pages", "numbers", "key"])
@pytest.mark.parametrize("legacy_path", [False, True])
def test_iwork_preview_pdf(client, ext, legacy_path):
    body = ok(post(client, f"angebot.{ext}", samples.iwork(legacy_path=legacy_path)))
    assert [p["page"] for p in body["pages"]] == [1, 2]
    assert "NT-601" in body["pages"][0]["text"]
    assert body["meta"]["format"] == ext
    assert body["meta"]["pageCount"] == 2


def test_iwork_without_preview_is_unsupported(client):
    body = failed(post(client, "angebot.pages", samples.iwork(preview=False)), "unsupported")
    assert "PDF preview" in body["error"]["message"]


# -- mbox --------------------------------------------------------------------------


def test_mbox_one_item_per_message(client):
    body = ok(post(client, "postfach.mbox", samples.mbox()))
    assert [p["page"] for p in body["pages"]] == [1, 2]
    first, second = body["pages"][0]["text"], body["pages"][1]["text"]
    assert "From: Anna Beispiel <anna@example.com>" in first
    assert "Subject: Preisanfrage NT-601" in first
    assert "Attachments: angebot.pdf" in first
    assert "bitte Preise prüfen." in first
    assert "\n>From the archive: alte Zeile" in first
    assert "Subject: Re: Preisanfrage NT-601" in second
    assert "Preis ist 412 Euro." in second
    assert body["meta"]["pageCount"] == 2


def test_mbox_message_cap(monkeypatch, tmp_path):
    import app.formats.mail as mail
    from app.job import Job

    monkeypatch.setattr(mail, "MAX_MBOX_MESSAGES", 1)
    path = tmp_path / "postfach.mbox"
    path.write_bytes(samples.mbox())
    job = Job(path=str(path), ext="mbox", workdir=str(tmp_path), max_chars=100_000)
    mail.extract_mbox(job)
    job.out.finish()
    assert [p["page"] for p in job.out.pages] == [1]
    assert job.out.truncated is True


def test_mbox_garbage_is_corrupt(client):
    failed(post(client, "postfach.mbox", b"no mailbox here\n"), "corrupt")


def test_new_types_as_mail_attachments(client):
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["Subject"] = "Anhang"
    msg.set_content("Siehe Anhang")
    msg.add_attachment(samples.svg(), maintype="image", subtype="svg+xml", filename="plan.svg")
    msg.add_attachment(b"SELECT * FROM artikel WHERE nr = 'NT-601';", maintype="text", subtype="plain", filename="abfrage.sql")
    text = all_text(ok(post(client, "mail.eml", msg.as_bytes())))
    assert "--- Attachment: plan.svg ---" in text
    assert "Tür NT-601 links" in text
    assert "SELECT * FROM artikel" in text
