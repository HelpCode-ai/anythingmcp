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

ZIP_FORMATS = {"xlsx", "xlsm", "docx", "pptx", "odt", "ods", "odp"}
# OOXML file that turned out to be an unencrypted OLE file -> legacy parser.
_OOXML_TO_LEGACY = {"xlsx": "xls", "xlsm": "xls", "docx": "doc", "pptx": "ppt"}
_LEGACY_TO_OOXML = {"xls": "xlsx", "doc": "docx", "ppt": "pptx"}

_LABELS = {
    "pdf": "PDF", "xlsx": "Excel", "xlsm": "Excel", "xls": "Excel",
    "ods": "OpenDocument spreadsheet", "csv": "CSV", "tsv": "TSV",
    "docx": "Word", "doc": "Word", "odt": "OpenDocument text",
    "odp": "OpenDocument presentation", "pptx": "PowerPoint", "ppt": "PowerPoint",
    "rtf": "RTF", "msg": "Outlook message", "eml": "e-mail",
}


def label(ext: str) -> str:
    return _LABELS.get(ext, ext.upper())


def _handlers() -> dict[str, Callable[[Job], None]]:
    # Imported lazily so the parent process never loads parser libraries.
    from . import legacy, mail, office, odf, pdf, spreadsheet, text

    return {
        "pdf": pdf.extract_pdf,
        "xlsx": spreadsheet.extract_xlsx,
        "xlsm": spreadsheet.extract_xlsx,
        "xls": spreadsheet.extract_xls,
        "ods": odf.extract_ods,
        "csv": spreadsheet.extract_csv,
        "tsv": spreadsheet.extract_csv,
        "docx": office.extract_docx,
        "odt": odf.extract_odt,
        "odp": odf.extract_odp,
        "pptx": office.extract_pptx,
        "doc": legacy.extract_doc,
        "ppt": legacy.extract_ppt,
        "rtf": text.extract_rtf,
        "txt": text.extract_plain,
        "md": text.extract_plain,
        "json": text.extract_plain,
        "xml": text.extract_plain,
        "log": text.extract_plain,
        "html": text.extract_html,
        "htm": text.extract_html,
        "msg": mail.extract_msg_file,
        "eml": mail.extract_eml,
    }


SUPPORTED_EXTENSIONS = (
    "pdf", "xlsx", "xlsm", "xls", "ods", "csv", "tsv", "docx", "odt", "odp",
    "pptx", "doc", "ppt", "rtf", "txt", "md", "json", "xml", "log", "html",
    "htm", "msg", "eml",
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
        raise ExtractError("unsupported", f"Files of type .{ext} are not supported." if ext else "Files without an extension are not supported.")
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
