# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Format registry and dispatch.

The extension picks the parser, but the first bytes are checked too: a
``.doc`` that is really RTF or DOCX, an ``.xlsx`` that is really an
encrypted (OLE-wrapped) workbook, or an ``.xls`` that is an HTML export
are all common in real file shares.
"""

from __future__ import annotations

from typing import Callable

from ..errors import ExtractError
from ..job import Job
from ..zipguard import check_zip

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")

# Plain text family: decoded as text, never parsed (sizes capped like .txt).
TEXT_FORMATS = ("txt", "md", "json", "xml", "log")
SOURCE_FORMATS = (
    # configuration, data and markup
    "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "sql", "tex",
    "bib", "srt", "vtt", "ics", "vcf", "kml", "gpx",
    # source code
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "kts", "c",
    "h", "cpp", "hpp", "cc", "cs", "go", "rb", "php", "sh", "bash", "ps1",
    "bat", "cmd", "swift", "rs", "r", "scala", "vb", "vbs", "pl", "lua", "css",
    "scss", "less", "sass", "gradle", "groovy", "dart", "m", "asm",
)

WORD_OOXML = ("docx", "docm", "dotx", "dotm")
EXCEL_OOXML = ("xlsx", "xlsm", "xltx", "xltm")
POWERPOINT_OOXML = ("pptx", "pptm", "ppsx", "ppsm", "potx", "potm")
IWORK = ("pages", "numbers", "key")

ZIP_FORMATS = {
    *WORD_OOXML, *EXCEL_OOXML, *POWERPOINT_OOXML, "xlsb",
    "odt", "ods", "odp", "ott", "ots", "otp",
    "epub", "xps", "oxps", *IWORK,
}
# OOXML file that turned out to be an unencrypted OLE file -> legacy parser.
_OOXML_TO_LEGACY = {
    **{ext: "doc" for ext in WORD_OOXML},
    **{ext: "xls" for ext in (*EXCEL_OOXML, "xlsb")},
    **{ext: "ppt" for ext in POWERPOINT_OOXML},
}
_LEGACY_TO_OOXML = {"xls": "xlsx", "doc": "docx", "ppt": "pptx"}

_LABELS = {
    "pdf": "PDF", "xls": "Excel", "xlsb": "Excel",
    "ods": "OpenDocument spreadsheet", "ots": "OpenDocument spreadsheet template",
    "csv": "CSV", "tsv": "TSV", "doc": "Word",
    "odt": "OpenDocument text", "ott": "OpenDocument text template",
    "odp": "OpenDocument presentation", "otp": "OpenDocument presentation template",
    "ppt": "PowerPoint", "rtf": "RTF", "msg": "Outlook message", "eml": "e-mail",
    "mbox": "mailbox", "svg": "SVG", "epub": "EPUB", "xps": "XPS", "oxps": "OpenXPS",
    "pages": "Pages", "numbers": "Numbers", "key": "Keynote", "dxf": "DXF",
    **{ext: "Word" for ext in WORD_OOXML},
    **{ext: "Excel" for ext in EXCEL_OOXML},
    **{ext: "PowerPoint" for ext in POWERPOINT_OOXML},
}

# Known types that cannot be read, with a more useful message than the
# generic one. They are not in SUPPORTED_EXTENSIONS.
UNSUPPORTED_MESSAGES = {
    "dwg": "DWG drawings cannot be read (there is no free DWG reader). Save the drawing as DXF to make its text searchable.",
}


def label(ext: str) -> str:
    return _LABELS.get(ext, ext.upper())


def unsupported_message(ext: str) -> str:
    if not ext:
        return "Files without an extension are not supported."
    return UNSUPPORTED_MESSAGES.get(ext, f"Files of type .{ext} are not supported.")


def _handlers() -> dict[str, Callable[[Job], None]]:
    # Imported lazily so the parent process never loads parser libraries.
    from . import drawing, ebook, iwork, legacy, mail, office, odf, pdf, spreadsheet, text, xps

    return {
        "pdf": pdf.extract_pdf,
        **{ext: spreadsheet.extract_xlsx for ext in EXCEL_OOXML},
        "xlsb": spreadsheet.extract_xlsb,
        "xls": spreadsheet.extract_xls,
        "ods": odf.extract_ods,
        "ots": odf.extract_ods,
        "csv": spreadsheet.extract_csv,
        "tsv": spreadsheet.extract_csv,
        **{ext: office.extract_docx for ext in WORD_OOXML},
        "odt": odf.extract_odt,
        "ott": odf.extract_odt,
        "odp": odf.extract_odp,
        "otp": odf.extract_odp,
        **{ext: office.extract_pptx for ext in POWERPOINT_OOXML},
        "doc": legacy.extract_doc,
        "ppt": legacy.extract_ppt,
        "rtf": text.extract_rtf,
        **{ext: text.extract_plain for ext in TEXT_FORMATS},
        **{ext: text.extract_source for ext in SOURCE_FORMATS},
        "html": text.extract_html,
        "htm": text.extract_html,
        "msg": mail.extract_msg_file,
        "eml": mail.extract_eml,
        "mbox": mail.extract_mbox,
        "svg": drawing.extract_svg,
        "dxf": drawing.extract_dxf,
        "epub": ebook.extract_epub,
        "xps": xps.extract_xps,
        "oxps": xps.extract_xps,
        **{ext: iwork.extract_iwork for ext in IWORK},
    }


SUPPORTED_EXTENSIONS = (
    "pdf", "xlsx", "xlsm", "xltx", "xltm", "xlsb", "xls", "ods", "ots", "csv",
    "tsv", "docx", "docm", "dotx", "dotm", "odt", "ott", "odp", "otp", "pptx",
    "pptm", "ppsx", "ppsm", "potx", "potm", "doc", "ppt", "rtf", "txt", "md",
    "json", "xml", "log", "html", "htm", "msg", "eml", "mbox", "svg", "dxf",
    "epub", "xps", "oxps", "pages", "numbers", "key",
    *SOURCE_FORMATS,
)


def _head(path: str, n: int = 16) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(n)


def _ole_is_encrypted_ooxml(path: str) -> bool:
    try:
        import olefile

        with olefile.OleFileIO(path) as ole:
            return ole.exists("EncryptionInfo") or ole.exists("EncryptedPackage")
    except Exception:
        return False


def _looks_like_markup(head: bytes) -> bool:
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return stripped.startswith(b"<")


def resolve_handler(job: Job) -> Callable[[Job], None]:
    """Pick the parser for ``job`` after sniffing the first bytes.

    Runs the ZIP bomb check for ZIP-based formats. Raises ``ExtractError``.
    """
    handlers = _handlers()
    ext = job.ext
    if ext not in handlers:
        raise ExtractError("unsupported", unsupported_message(ext))
    head = _head(job.path, 1024)

    if ext in ZIP_FORMATS:
        if head.startswith(OLE_MAGIC):
            if _ole_is_encrypted_ooxml(job.path):
                raise ExtractError("encrypted", f"The {label(ext)} file is password-protected.")
            legacy_ext = _OOXML_TO_LEGACY.get(ext)
            if legacy_ext is None:
                raise ExtractError("corrupt", f"The file is not a valid {label(ext)} file.")
            return handlers[legacy_ext]
        if not head.startswith(ZIP_MAGICS):
            raise ExtractError("corrupt", f"The file is not a valid {label(ext)} file (not a ZIP container).")
        check_zip(job.path, label(ext))
        return handlers[ext]

    if ext in _LEGACY_TO_OOXML:
        if head.startswith(ZIP_MAGICS):
            modern = _LEGACY_TO_OOXML[ext]
            check_zip(job.path, label(modern))
            return handlers[modern]
        if ext == "doc" and head.startswith(b"{\\rtf"):
            return handlers["rtf"]
        if ext == "xls" and not head.startswith(OLE_MAGIC):
            # "Excel" exports from web applications are often HTML or CSV.
            return handlers["html"] if _looks_like_markup(head) else handlers["csv"]
        return handlers[ext]

    return handlers[ext]


def run_extraction(job: Job) -> None:
    handler = resolve_handler(job)
    handler(job)
    job.out.finish()
