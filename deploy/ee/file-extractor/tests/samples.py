# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Programmatically generated test documents.

Also usable from the shell (test.sh): ``python -m tests.samples xlsx out.xlsx``.
"""

from __future__ import annotations

import datetime as dt
import io
import sys
import zipfile
from email.message import EmailMessage

# -- PDF ------------------------------------------------------------------------


def pdf(pages: list[str], *, user_password: str | None = None) -> bytes:
    from fpdf import FPDF

    doc = FPDF()
    doc.set_title("Testdokument")
    doc.set_author("Einkauf")
    doc.set_font("Helvetica", size=12)
    for text in pages:
        doc.add_page()
        if text:
            doc.multi_cell(0, 8, text)
    if user_password:
        doc.set_encryption(owner_password="owner-" + user_password, user_password=user_password)
    return bytes(doc.output())


def encrypted_pdf() -> bytes:
    return pdf(["Geheimer Inhalt der Seite eins, lang genug fuer einen Textlayer."], user_password="secret")


def scanned_pdf(text: str = "INVOICE 4711") -> bytes:
    """A PDF whose only page is an image of text (no text layer)."""
    from fpdf import FPDF
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1600, 400), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=120)
    draw.text((60, 120), text, fill="black", font=font)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    doc = FPDF()
    doc.add_page()
    doc.image(buf, x=10, y=20, w=190)
    return bytes(doc.output())


# -- spreadsheets ---------------------------------------------------------------


def xlsx(big_rows: int = 450) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Preise"
    ws.append(["Artikel", "Breite", "Preis", "Lieferdatum", None, "Notiz"])
    ws.append(["NT-601", 875, 412.0000000001, dt.datetime(2026, 3, 1), None, None])
    ws.append(["NT-602", 1000, 99.5, dt.datetime(2026, 3, 1, 14, 30), "x", "zwei\nZeilen"])
    ws.append([])
    ws.append(["NT-603", 750, 10, None, None, True])
    wb.create_sheet("Leer")
    big = wb.create_sheet("Gross")
    big.append(["Nr", "Wert"])
    for i in range(1, big_rows + 1):
        big.append([f"A-{i:05d}", i * 1.5])
    wb.properties.title = "Preisliste 2026"
    wb.properties.creator = "Einkauf"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def xls() -> bytes:
    import xlwt

    wb = xlwt.Workbook()
    ws = wb.add_sheet("Preise")
    date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD")
    for c, h in enumerate(["Artikel", "Breite", "Preis", "Lieferdatum"]):
        ws.write(0, c, h)
    ws.write(1, 0, "NT-601")
    ws.write(1, 1, 875)
    ws.write(1, 2, 412.0000000001)
    ws.write(1, 3, dt.datetime(2026, 3, 1), date_style)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def csv_semicolon_cp1252() -> bytes:
    lines = ["Artikel;Bezeichnung;Preis"]
    lines.append("NT-601;Türblatt weiß;412,00")
    for i in range(30):
        lines.append(f"NT-{700 + i};Zarge für Größe {i};{i},50")
    return ("\r\n".join(lines) + "\r\n").encode("cp1252")


def tsv() -> bytes:
    return "Artikel\tPreis\nNT-601\t412\n".encode()


# -- OpenDocument ---------------------------------------------------------------

_ODF_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
    'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"'
)


def _odf(mimetype: str, body: str, *, encrypted: bool = False) -> bytes:
    content = f'<?xml version="1.0" encoding="UTF-8"?><office:document-content {_ODF_NS} office:version="1.3"><office:body>{body}</office:body></office:document-content>'
    meta = f'<?xml version="1.0" encoding="UTF-8"?><office:document-meta {_ODF_NS}><office:meta><dc:title>ODF Titel</dc:title><dc:creator>Autorin</dc:creator></office:meta></office:document-meta>'
    enc = '<manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="x"/>' if encrypted else ""
    manifest = f'<?xml version="1.0" encoding="UTF-8"?><manifest:manifest {_ODF_NS}><manifest:file-entry manifest:full-path="/" manifest:media-type="{mimetype}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">{enc}</manifest:file-entry></manifest:manifest>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), mimetype, compress_type=zipfile.ZIP_STORED)
        zf.writestr("content.xml", content, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("meta.xml", meta, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("META-INF/manifest.xml", manifest, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def odt(*, encrypted: bool = False) -> bytes:
    body = (
        "<office:text>"
        "<text:h>Überschrift</text:h>"
        '<text:p>Hallo<text:s text:c="2"/>Welt<text:tab/>Tab</text:p>'
        '<table:table table:name="T1"><table:table-row>'
        "<table:table-cell><text:p>A1</text:p></table:table-cell>"
        "<table:table-cell><text:p>B1</text:p></table:table-cell>"
        "</table:table-row></table:table>"
        "<text:p>Ende <text:span>mit Span</text:span> danach</text:p>"
        "</office:text>"
    )
    return _odf("application/vnd.oasis.opendocument.text", body, encrypted=encrypted)


def ods() -> bytes:
    def cell(text: str) -> str:
        return f'<table:table-cell office:value-type="string"><text:p>{text}</text:p></table:table-cell>'

    def num(value: str) -> str:
        return f'<table:table-cell office:value-type="float" office:value="{value}"><text:p>{value}</text:p></table:table-cell>'

    body = (
        '<office:spreadsheet><table:table table:name="Preise">'
        f"<table:table-row>{cell('Artikel')}{cell('Breite')}{cell('Preis')}<table:table-cell/>{cell('Datum')}</table:table-row>"
        f"<table:table-row>{cell('NT-601')}{num('875')}{num('412.0000000001')}</table:table-row>"
        '<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
        f'<table:table-row>{cell("NT-602")}<table:table-cell table:number-columns-repeated="2"/>'
        '<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>WAHR</text:p></table:table-cell>'
        '<table:table-cell office:value-type="date" office:date-value="2026-03-01T00:00:00"><text:p>01.03.26</text:p></table:table-cell>'
        "</table:table-row>"
        "</table:table></office:spreadsheet>"
    )
    return _odf("application/vnd.oasis.opendocument.spreadsheet", body)


def odp() -> bytes:
    def frame(text: str) -> str:
        return f"<draw:frame><draw:text-box><text:p>{text}</text:p></draw:text-box></draw:frame>"

    body = (
        "<office:presentation>"
        f'<draw:page draw:name="p1">{frame("Folie eins")}<presentation:notes>{frame("Notiz eins")}</presentation:notes></draw:page>'
        f'<draw:page draw:name="p2">{frame("Folie zwei")}</draw:page>'
        "</office:presentation>"
    )
    return _odf("application/vnd.oasis.opendocument.presentation", body)


# -- Office Open XML --------------------------------------------------------------


def docx(paragraphs: int = 0) -> bytes:
    import docx as python_docx

    document = python_docx.Document()
    document.core_properties.title = "Angebot"
    document.core_properties.author = "Vertrieb"
    document.add_heading("Angebot 2026", 1)
    document.add_paragraph("Sehr geehrte Damen und Herren, anbei unser Angebot.")
    table = document.add_table(rows=2, cols=3)
    for c, text in enumerate(["Artikel", "Breite", "Preis"]):
        table.cell(0, c).text = text
    for c, text in enumerate(["NT-601", "875", "412"]):
        table.cell(1, c).text = text
    for i in range(paragraphs):
        document.add_paragraph(f"Absatz {i}: " + "Lorem ipsum dolor sit amet. " * 20)
    document.add_paragraph("Mit freundlichen Grüßen")
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def pptx() -> bytes:
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    presentation.core_properties.title = "Schulung"
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "Willkommen"
    slide.placeholders[1].text = "Erste Folie"
    slide.notes_slide.notes_text_frame.text = "Sprechernotiz"
    slide2 = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide2.shapes.title.text = "Preise"
    shape = slide2.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1))
    shape.table.cell(0, 0).text = "Artikel"
    shape.table.cell(0, 1).text = "Preis"
    shape.table.cell(1, 0).text = "NT-601"
    shape.table.cell(1, 1).text = "412"
    buf = io.BytesIO()
    presentation.save(buf)
    return buf.getvalue()


def ole_encrypted_ooxml() -> bytes:
    """What Office writes for a password-protected .docx/.xlsx: an OLE file."""
    import os
    import tempfile

    import extract_msg

    writer = extract_msg.OleWriter()
    writer.addEntry("EncryptionInfo", data=b"\x04\x00\x04\x00" + b"\x00" * 100)
    writer.addEntry("EncryptedPackage", data=b"\x00" * 600)
    fd, path = tempfile.mkstemp(suffix=".bin")
    os.close(fd)
    try:
        writer.write(path)
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(path)


# -- hostile ZIPs -------------------------------------------------------------------


def zip_bomb_ratio() -> bytes:
    """20 MB of zeros deflated to ~20 KB (ratio ~1000)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/document.xml", b"\0" * (20 * 1024 * 1024))
    return buf.getvalue()


def zip_many_entries(count: int = 10_001) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for i in range(count):
            zf.writestr(f"e/{i}", b"")
    return buf.getvalue()


def zip_declared_huge() -> bytes:
    """A small ZIP whose directory claims 600 MB of content."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("content.xml", b"0123456789")
    data = bytearray(buf.getvalue())
    cd = data.rfind(b"PK\x01\x02")
    data[cd + 24:cd + 28] = (600 * 1024 * 1024).to_bytes(4, "little")
    return bytes(data)


# -- text formats ---------------------------------------------------------------------


def html() -> bytes:
    return (
        "<!doctype html><html><head><title>Preis Seite</title>"
        "<style>body{color:red}</style><script>var secret = 'SCRIPT-CONTENT';</script></head>"
        "<body><h1>Preise</h1><p>Erster&nbsp;Absatz &amp; mehr.</p>"
        "<table><tr><th>Artikel</th><th>Preis</th></tr><tr><td>NT-601</td><td>412</td></tr></table>"
        "<ul><li>Eins</li><li>Zwei</li></ul></body></html>"
    ).encode("utf-8")


def rtf() -> bytes:
    return (
        rb"{\rtf1\ansi\ansicpg1252\deff0 {\fonttbl{\f0 Arial;}}\f0 Gr\'fc\'dfe aus RTF\par Zweite Zeile\par}"
    )


def text_latin1() -> bytes:
    return ("Größenangaben für Türen: Breite 875 mm, Höhe 2000 mm. Ölfarbe, Maße geprüft. " * 5).encode("latin-1")


def xml_entity_bomb() -> bytes:
    """Never parsed as XML by the extractor, so the bomb stays text."""
    return (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
        '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>'
        "<lolz>&lol3;</lolz>"
    ).encode()


# -- mail -------------------------------------------------------------------------


def eml() -> bytes:
    msg = EmailMessage()
    msg["From"] = "Anna Beispiel <anna@example.com>"
    msg["To"] = "Einkauf <einkauf@example.com>"
    msg["Cc"] = "Chef <chef@example.com>"
    msg["Subject"] = "Preisanfrage Türen"
    msg["Date"] = "Mon, 02 Mar 2026 10:00:00 +0100"
    msg.set_content("Hallo,\n\nbitte Preise für NT-601 prüfen.\n\nGruß Anna\n")
    msg.add_alternative("<p>Hallo, <b>HTML-Version</b></p>", subtype="html")
    msg.add_attachment(csv_semicolon_cp1252(), maintype="text", subtype="csv", filename="preise.csv")
    msg.add_attachment(docx(), maintype="application",
                       subtype="vnd.openxmlformats-officedocument.wordprocessingml.document",
                       filename="angebot.docx")
    msg.add_attachment(b"MZ\x90\x00binary", maintype="application", subtype="octet-stream", filename="tool.exe")
    inner = EmailMessage()
    inner["Subject"] = "Innere Nachricht"
    inner.set_content("NESTED-BODY-SHOULD-NOT-APPEAR")
    msg.add_attachment(inner, filename="weitergeleitet.eml")
    return msg.as_bytes()


def eml_signed() -> bytes:
    return (
        b"From: signer@example.com\r\n"
        b"To: einkauf@example.com\r\n"
        b"Subject: Signierte Nachricht\r\n"
        b"MIME-Version: 1.0\r\n"
        b'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="BOUNDARY"\r\n'
        b"\r\n"
        b"--BOUNDARY\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n"
        b"\r\n"
        b"Signierter Text mit Inhalt.\r\n"
        b"--BOUNDARY\r\n"
        b'Content-Type: application/pkcs7-signature; name="smime.p7s"\r\n'
        b"Content-Transfer-Encoding: base64\r\n"
        b'Content-Disposition: attachment; filename="smime.p7s"\r\n'
        b"\r\n"
        b"!!!not-base64!!!\r\n"
        b"--BOUNDARY--\r\n"
    )


GENERATORS = {
    "xlsx": xlsx,
    "pdf": lambda: pdf(["Seite eins mit dem Artikel NT-601 und genug Text fuer den Textlayer.",
                        "Seite zwei: Preis 412 Euro, Breite 875 mm, Lieferzeit drei Wochen."]),
    "docx": docx,
    "pptx": pptx,
    "eml": eml,
}


if __name__ == "__main__":
    kind, target = sys.argv[1], sys.argv[2]
    with open(target, "wb") as fh:
        fh.write(GENERATORS[kind]())
