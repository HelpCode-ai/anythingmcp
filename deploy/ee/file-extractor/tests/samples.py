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


# -- Office variants ----------------------------------------------------------------


def retype_ooxml(data: bytes, old: str, new: str) -> bytes:
    """Change the main part's content type, as Office does for macro-enabled
    files, templates and slide shows."""
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            content = src.read(info)
            if info.filename == "[Content_Types].xml":
                assert old.encode() in content, old
                content = content.replace(old.encode(), new.encode())
            dst.writestr(info.filename, content)
    return buf.getvalue()


WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
PPT_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
XLSX_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
VARIANT_TYPES = {
    "docm": "application/vnd.ms-word.document.macroEnabled.main+xml",
    "dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    "dotm": "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
    "xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
    "xltm": "application/vnd.ms-excel.template.macroEnabled.main+xml",
    "pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
    "ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
    "ppsm": "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
    "potx": "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
    "potm": "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
}


def office_variant(ext: str) -> bytes:
    if ext in ("docm", "dotx", "dotm"):
        return retype_ooxml(docx(), WORD_MAIN, VARIANT_TYPES[ext])
    if ext in ("xltx", "xltm"):
        return retype_ooxml(xlsx(big_rows=3), XLSX_MAIN, VARIANT_TYPES[ext])
    return retype_ooxml(pptx(), PPT_MAIN, VARIANT_TYPES[ext])


def odf_template(ext: str) -> bytes:
    """OpenDocument templates: same content as the documents, other mimetype."""
    base = {"ott": odt, "ots": ods, "otp": odp}[ext]()
    src = zipfile.ZipFile(io.BytesIO(base))
    mimetype = {
        "ott": "application/vnd.oasis.opendocument.text-template",
        "ots": "application/vnd.oasis.opendocument.spreadsheet-template",
        "otp": "application/vnd.oasis.opendocument.presentation-template",
    }[ext]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as dst:
        dst.writestr(zipfile.ZipInfo("mimetype"), mimetype, compress_type=zipfile.ZIP_STORED)
        for info in src.infolist():
            if info.filename != "mimetype":
                dst.writestr(info.filename, src.read(info), compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


# -- Excel binary (.xlsb) -------------------------------------------------------------

def _b12_record(recid: int, payload: bytes = b"") -> bytes:
    """One BIFF12 record: id as stored (1-2 bytes), 7-bit varint length."""
    rid = bytes([recid & 0xFF]) if recid < 0x80 else bytes([recid & 0xFF, recid >> 8])
    length, n = b"", len(payload)
    while True:
        byte = n & 0x7F
        n >>= 7
        length += bytes([byte | (0x80 if n else 0)])
        if not n:
            break
    return rid + length + payload


def _b12_string(text: str) -> bytes:
    import struct

    return struct.pack("<I", len(text)) + text.encode("utf-16-le")


def xlsb(*, huge_dimension: bool = False) -> bytes:
    """A minimal Excel binary workbook: one sheet "Preise", header + 2 rows."""
    import struct

    strings = ["Artikel", "Breite", "Preis", "NT-601", "NT-602"]
    sst = _b12_record(0x019F, struct.pack("<II", len(strings), len(strings)))
    for text in strings:
        sst += _b12_record(0x0013, b"\x00" + _b12_string(text))
    sst += _b12_record(0x01A0)

    workbook = _b12_record(0x018F)
    workbook += _b12_record(0x019C, struct.pack("<II", 0, 1) + _b12_string("rId1") + _b12_string("Preise"))
    workbook += _b12_record(0x0190)

    def sst_cell(col: int, index: int) -> bytes:
        return _b12_record(0x0007, struct.pack("<III", col, 0, index))

    def num_cell(col: int, value: float) -> bytes:
        return _b12_record(0x0005, struct.pack("<IId", col, 0, value))

    last_col = 0x3FFF if huge_dimension else 2
    sheet = _b12_record(0x0194, struct.pack("<IIII", 0, 1_048_575 if huge_dimension else 2, 0, last_col))
    sheet += _b12_record(0x0191)
    sheet += _b12_record(0x0000, struct.pack("<I", 0)) + sst_cell(0, 0) + sst_cell(1, 1) + sst_cell(2, 2)
    sheet += _b12_record(0x0000, struct.pack("<I", 1)) + sst_cell(0, 3) + num_cell(1, 875) + num_cell(2, 412.0000000001)
    sheet += _b12_record(0x0000, struct.pack("<I", 2)) + sst_cell(0, 4) + num_cell(1, 1000) + num_cell(2, 99.5)
    sheet += _b12_record(0x0192)

    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>'
        "</Relationships>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("xl/workbook.bin", workbook)
        zf.writestr("xl/_rels/workbook.bin.rels", rels)
        zf.writestr("xl/sharedStrings.bin", sst)
        zf.writestr("xl/worksheets/sheet1.bin", sheet)
    return buf.getvalue()


# -- drawings -------------------------------------------------------------------------

def svg() -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">'
        "<title>Grundriss EG</title><desc>Erdgeschoss mit Tueren</desc>"
        "<style>.cls{fill:STYLE-CONTENT}</style><script>var x='SCRIPT-CONTENT';</script>"
        '<path d="M0 0 L10 10"/>'
        '<text x="10" y="20">Tür <tspan font-weight="bold">NT-601</tspan> links</text>'
        '<text x="10" y="40"><tspan x="10" y="40">Zeile eins</tspan><tspan x="10" y="55">Zeile zwei</tspan></text>'
        "</svg>"
    ).encode()


def svg_illustrator() -> bytes:
    """Adobe Illustrator declares namespaces as internal entities."""
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" ['
        '<!ENTITY ns_svg "http://www.w3.org/2000/svg"><!ENTITY ns_xlink "http://www.w3.org/1999/xlink">]>'
        '<svg version="1.1" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;"><text>Illustrator Text</text></svg>'
    ).encode()


def svg_xxe(target: str = "/etc/passwd") -> bytes:
    return (
        f'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file://{target}">]>'
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Vorher &xxe; nachher</text></svg>'
    ).encode()


def svg_parameter_xxe() -> bytes:
    return (
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY % remote SYSTEM "http://127.0.0.1:9/evil.dtd">%remote;]>'
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Hallo</text></svg>'
    ).encode()


def svg_entity_bomb() -> bytes:
    entities = '<!ENTITY a0 "lollollollollollollollollollol">'
    for i in range(1, 10):
        entities += f'<!ENTITY a{i} "{("&a" + str(i - 1) + ";") * 10}">'
    return (
        f'<?xml version="1.0"?><!DOCTYPE svg [{entities}]>'
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&a9;</text></svg>'
    ).encode()


def dxf() -> bytes:
    def pairs(*items) -> str:
        return "".join(f"{code:>3}\r\n{value}\r\n" for code, value in items)

    body = (
        pairs((0, "SECTION"), (2, "HEADER"), (9, "$ACADVER"), (1, "AC1015"),
              (9, "$DWGCODEPAGE"), (3, "ANSI_1252"), (0, "ENDSEC"))
        + pairs((0, "SECTION"), (2, "ENTITIES"))
        + pairs((0, "LINE"), (8, "0"), (10, "0.0"), (20, "0.0"), (11, "10.0"), (21, "10.0"))
        + pairs((0, "TEXT"), (8, "0"), (10, "1.0"), (20, "1.0"), (40, "2.5"), (1, "Tür NT-601 %%c80 %%p0.5"))
        + pairs((0, "MTEXT"), (8, "0"), (10, "1.0"), (20, "5.0"), (3, "{\\fArial|b1|i0|c0|p34;Erste "),
                (1, "Zeile}\\PZweite \\H2.5x;Zeile \\S1/2; \\U+00D8 30"))
        + pairs((0, "INSERT"), (2, "TITELBLOCK"), (66, "1"))
        + pairs((0, "ATTRIB"), (8, "0"), (1, "Grundriss EG"), (2, "TITEL"), (70, "0"))
        + pairs((0, "SEQEND"))
        + pairs((0, "ENDSEC"), (0, "EOF"))
    )
    return body.encode("cp1252")


def dxf_binary() -> bytes:
    return b"AutoCAD Binary DXF\r\n\x1a\x00" + b"\x00" * 64


# -- packages: EPUB, XPS, iWork -------------------------------------------------------

def epub(*, drm: bool = False, xxe: bool = False) -> bytes:
    container = (
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Montageanleitung</dc:title>'
        "<dc:creator>Technik</dc:creator></metadata>"
        '<manifest><item id="c2" href="text/kapitel%202.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="c1" href="text/kapitel1.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="css" href="style.css" media-type="text/css"/>'
        '<item id="img" href="bild.png" media-type="image/png"/></manifest>'
        '<spine><itemref idref="c1"/><itemref idref="img"/><itemref idref="c2"/></spine></package>'
    )
    doctype = '<!DOCTYPE html [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' if xxe else "<!DOCTYPE html>"
    chapter1 = (
        f'<?xml version="1.0" encoding="UTF-8"?>{doctype}'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kapitel 1</title></head>'
        "<body><h1>Kapitel eins</h1><p>Zarge NT-601 montieren.</p>"
        + ("<p>Inhalt: &xxe;</p>" if xxe else "")
        + "</body></html>"
    )
    chapter2 = (
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml">'
        "<body><h1>Kapitel zwei</h1><p>Türblatt einhängen.</p></body></html>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container)
        if drm:
            zf.writestr(
                "META-INF/encryption.xml",
                '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">'
                '<enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/text/kapitel1.xhtml"/></enc:CipherData></enc:EncryptedData>'
                '<enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/text/kapitel%202.xhtml"/></enc:CipherData></enc:EncryptedData>'
                "</encryption>",
            )
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/text/kapitel1.xhtml", chapter1)
        zf.writestr("OEBPS/text/kapitel 2.xhtml", chapter2)
        zf.writestr("OEBPS/style.css", "body{}")
        zf.writestr("OEBPS/bild.png", b"\x89PNG\r\n\x1a\n")
    return buf.getvalue()


def xps(*, openxps: bool = False, xxe: bool = False) -> bytes:
    if openxps:
        ns = "http://schemas.openxps.org/oxps/v1.0"
        rel_type = "http://schemas.openxps.org/oxps/v1.0/fixedrepresentation"
    else:
        ns = "http://schemas.microsoft.com/xps/2005/06"
        rel_type = "http://schemas.microsoft.com/xps/2005/06/fixedrepresentation"
    rels = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="R0" Type="{rel_type}" Target="/FixedDocumentSequence.fdseq"/></Relationships>'
    )
    fdseq = f'<FixedDocumentSequence xmlns="{ns}"><DocumentReference Source="Documents/1/FixedDocument.fdoc"/></FixedDocumentSequence>'
    fdoc = (
        f'<FixedDocument xmlns="{ns}"><PageContent Source="Pages/2.fpage"/>'
        '<PageContent Source="Pages/1.fpage"/></FixedDocument>'
    )

    def glyphs(x: float, y: float, text: str) -> str:
        return f'<Glyphs OriginX="{x}" OriginY="{y}" FontRenderingEmSize="12" FontUri="/f.ttf" UnicodeString="{text}"/>'

    prolog = '<?xml version="1.0"?><!DOCTYPE FixedPage [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' if xxe else ""
    page_a = (
        f'{prolog}<FixedPage xmlns="{ns}" Width="816" Height="1056">'
        + glyphs(10, 20, "Lieferschein")
        + glyphs(120, 20.5, "Nr. 4711")
        + f'<Canvas>{glyphs(10, 50, "{}{Artikel} NT-601")}</Canvas>'
        + (glyphs(10, 80, "&xxe;") if xxe else "")
        + "</FixedPage>"
    )
    page_b = f'<FixedPage xmlns="{ns}" Width="816" Height="1056">{glyphs(10, 20, "Seite zwei")}</FixedPage>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("_rels/.rels", rels)
        zf.writestr("FixedDocumentSequence.fdseq", fdseq)
        zf.writestr("Documents/1/FixedDocument.fdoc", fdoc)
        zf.writestr("Documents/1/Pages/2.fpage", page_a)
        zf.writestr("Documents/1/Pages/1.fpage", page_b)
    return buf.getvalue()


def iwork(*, preview: bool = True, legacy_path: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Index/Document.iwa", b"\x00\x01binary-protobuf")
        zf.writestr("preview.jpg", b"\xff\xd8\xff")
        if preview:
            name = "QuickLook/Preview.pdf" if legacy_path else "preview.pdf"
            zf.writestr(name, pdf(["Angebot aus Pages mit Artikel NT-601 und genug Text fuer den Textlayer.",
                                   "Zweite Seite der Vorschau mit Preis 412 Euro und Lieferzeit."]))
    return buf.getvalue()


# -- mailbox --------------------------------------------------------------------------

def mbox() -> bytes:
    first = EmailMessage()
    first["From"] = "Anna Beispiel <anna@example.com>"
    first["To"] = "einkauf@example.com"
    first["Subject"] = "Preisanfrage NT-601"
    first["Date"] = "Mon, 02 Mar 2026 10:00:00 +0100"
    first.set_content("Hallo,\n\nbitte Preise prüfen.\n\n>From the archive: alte Zeile\n")
    first.add_attachment(b"%PDF-1.4", maintype="application", subtype="pdf", filename="angebot.pdf")
    second = EmailMessage()
    second["From"] = "chef@example.com"
    second["To"] = "anna@example.com"
    second["Subject"] = "Re: Preisanfrage NT-601"
    second["Date"] = "Tue, 03 Mar 2026 09:00:00 +0100"
    second.set_content("Preis ist 412 Euro.\n")
    second.add_alternative("<p>Preis ist <b>412</b> Euro.</p>", subtype="html")
    out = b""
    for message in (first, second):
        raw = message.as_bytes().replace(b"\n>From the archive", b"\n>>From the archive")
        out += b"From MAILER-DAEMON Mon Mar  2 10:00:00 2026\n" + raw.replace(b"\r\n", b"\n") + b"\n"
    return out


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
