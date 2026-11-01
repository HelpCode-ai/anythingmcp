# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""EPUB: the chapters in reading (spine) order, one numbered item each.

``META-INF/container.xml`` names the package document (OPF); its spine lists
the chapters. Package files are parsed with ``defusedxml`` (no entities, no
external resources); chapters go through the HTML text extraction, which
never resolves entities or loads anything.
"""

from __future__ import annotations

import posixpath
import zipfile
from urllib.parse import unquote

from ..errors import ExtractError
from ..job import Job
from ..textdecode import decode_bytes
from .text import html_to_text

MAX_PACKAGE_XML_BYTES = 4 * 1024 * 1024
_CHAPTER_TYPES = {"application/xhtml+xml", "text/html", "application/x-dtbook+xml"}
_LABEL = "EPUB"


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _parse_small(zf: zipfile.ZipFile, name: str):
    from defusedxml.ElementTree import fromstring

    info = zf.getinfo(name)
    if info.file_size > MAX_PACKAGE_XML_BYTES:
        raise ExtractError("corrupt", f"The {_LABEL} package file is too large.")
    return fromstring(zf.read(info), forbid_dtd=False, forbid_entities=True, forbid_external=True)


def _find_ci(names: dict[str, str], name: str) -> str | None:
    return names.get(name.lower())


def _opf_path(zf: zipfile.ZipFile, names: dict[str, str]) -> str:
    container = _find_ci(names, "META-INF/container.xml")
    if container:
        for element in _parse_small(zf, container).iter():
            if _local(element.tag) == "rootfile":
                path = element.get("full-path")
                media = (element.get("media-type") or "application/oebps-package+xml").lower()
                if path and media == "application/oebps-package+xml":
                    found = _find_ci(names, unquote(path).lstrip("/"))
                    if found:
                        return found
    candidates = sorted(n for n in names.values() if n.lower().endswith(".opf"))
    if candidates:
        return candidates[0]
    raise ExtractError("corrupt", f"The file is not a valid {_LABEL} book (no package document).")


def _encrypted_paths(zf: zipfile.ZipFile, names: dict[str, str]) -> set[str]:
    """Content files listed in META-INF/encryption.xml (DRM). Fonts are
    often obfuscated the same way; only chapters matter here."""
    name = _find_ci(names, "META-INF/encryption.xml")
    if not name:
        return set()
    try:
        root = _parse_small(zf, name)
    except ExtractError:
        raise
    except Exception:
        return set()
    out = set()
    for element in root.iter():
        if _local(element.tag) == "CipherReference" and element.get("URI"):
            out.add(posixpath.normpath(unquote(element.get("URI")).lstrip("/")).lower())
    return out


def _text_of(element) -> str:
    return " ".join("".join(element.itertext()).split())


def extract_epub(job: Job) -> None:
    try:
        zf = zipfile.ZipFile(job.path)
    except (zipfile.BadZipFile, OSError):
        raise ExtractError("corrupt", f"The file is not a valid {_LABEL} book.") from None
    with zf:
        names = {n.lower(): n for n in zf.namelist()}
        try:
            opf_name = _opf_path(zf, names)
            opf = _parse_small(zf, opf_name)
        except ExtractError:
            raise
        except Exception:
            raise ExtractError("corrupt", f"The file is not a readable {_LABEL} book.") from None
        base = posixpath.dirname(opf_name)

        manifest: dict[str, tuple[str, str]] = {}
        spine: list[str] = []
        for element in opf.iter():
            tag = _local(element.tag)
            if tag == "item" and element.get("id") and element.get("href"):
                href = unquote(element.get("href").split("#", 1)[0])
                path = posixpath.normpath(posixpath.join(base, href)) if base else posixpath.normpath(href)
                manifest[element.get("id")] = (path, (element.get("media-type") or "").lower())
            elif tag == "itemref" and element.get("idref"):
                spine.append(element.get("idref"))
            elif tag == "title" and not job.meta.get("title"):
                job.meta["title"] = _text_of(element)[:500] or None
            elif tag == "creator" and not job.meta.get("author"):
                job.meta["author"] = _text_of(element)[:500] or None

        encrypted = _encrypted_paths(zf, names)
        job.meta["pageCount"] = len(spine)
        chapters = 0
        locked = 0
        for number, idref in enumerate(spine, 1):
            if job.out.full:
                job.out.mark_truncated()
                break
            path, media = manifest.get(idref, ("", ""))
            if not path or media not in _CHAPTER_TYPES:
                continue
            name = _find_ci(names, path)
            if name is None:
                continue
            chapters += 1
            if path.lower() in encrypted:
                locked += 1
                continue
            limit = job.max_chars * 4 + 4
            with zf.open(name) as fh:
                data = fh.read(limit)
            text, _title = html_to_text(decode_bytes(data))
            job.out.add_page(number, text)
        if chapters and locked == chapters:
            raise ExtractError("encrypted", f"The {_LABEL} book is protected with DRM.")
