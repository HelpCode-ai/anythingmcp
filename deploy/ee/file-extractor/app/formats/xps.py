# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""XPS and OpenXPS: text of the ``Glyphs`` runs, one item per FixedPage.

The page order comes from the package: the root relationship points to the
FixedDocumentSequence, which lists FixedDocuments, which list FixedPages.
Element names are matched without namespace, so XPS (2006) and OpenXPS
(ECMA-388) are read the same way. All XML goes through ``defusedxml`` (no
DTDs, no entities, no external resources) and pages are streamed.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from urllib.parse import unquote

from ..errors import ExtractError
from ..job import Job

MAX_PACKAGE_XML_BYTES = 4 * 1024 * 1024
_FIXED_REPRESENTATION = "fixedrepresentation"
# Glyphs on one baseline within this many units (1/96 inch) form one line.
_SAME_LINE = 2.0


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _label(job: Job) -> str:
    return "OpenXPS" if job.ext == "oxps" else "XPS"


def _parse_small(zf: zipfile.ZipFile, name: str):
    from defusedxml.ElementTree import fromstring

    info = zf.getinfo(name)
    if info.file_size > MAX_PACKAGE_XML_BYTES:
        raise ValueError("package part too large")
    return fromstring(zf.read(info), forbid_dtd=True, forbid_entities=True, forbid_external=True)


def _resolve(names: dict[str, str], base_part: str, target: str) -> str | None:
    target = unquote(target.split("#", 1)[0])
    if target.startswith("/"):
        path = target.lstrip("/")
    else:
        path = posixpath.join(posixpath.dirname(base_part), target)
    return names.get(posixpath.normpath(path).lower())


def _children_sources(zf, names, part: str, child_tag: str) -> list[str]:
    out = []
    for element in _parse_small(zf, part).iter():
        if _local(element.tag) == child_tag and element.get("Source"):
            resolved = _resolve(names, part, element.get("Source"))
            if resolved:
                out.append(resolved)
    return out


def _page_order(zf: zipfile.ZipFile, names: dict[str, str]) -> list[str]:
    try:
        sequence = None
        rels = names.get("_rels/.rels")
        if rels:
            for element in _parse_small(zf, rels).iter():
                if _local(element.tag) == "Relationship" and (element.get("Type") or "").lower().endswith(_FIXED_REPRESENTATION):
                    sequence = _resolve(names, "", element.get("Target") or "")
                    break
        if sequence:
            pages: list[str] = []
            for document in _children_sources(zf, names, sequence, "DocumentReference"):
                pages.extend(_children_sources(zf, names, document, "PageContent"))
            if pages:
                return pages
    except Exception:
        pass
    # Damaged package structure: every page part in natural order.
    def natural(name: str):
        return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name.lower())]

    return sorted((n for n in names.values() if n.lower().endswith(".fpage")), key=natural)


def _page_text(fh) -> str:
    from defusedxml.ElementTree import iterparse

    lines: list[list[str]] = []
    last_y: float | None = None
    for _event, element in iterparse(fh, events=("end",), forbid_dtd=True, forbid_entities=True, forbid_external=True):
        if _local(element.tag) == "Glyphs":
            text = element.get("UnicodeString") or ""
            if text.startswith("{}"):
                text = text[2:]  # escape for strings that start with "{"
            text = text.strip()
            if text:
                try:
                    y = float(element.get("OriginY") or "nan")
                except ValueError:
                    y = float("nan")
                if lines and last_y is not None and abs(y - last_y) <= _SAME_LINE:
                    lines[-1].append(text)
                else:
                    lines.append([text])
                last_y = y
        element.clear()
    return "\n".join(" ".join(parts) for parts in lines)


def extract_xps(job: Job) -> None:
    label = _label(job)
    try:
        zf = zipfile.ZipFile(job.path)
    except (zipfile.BadZipFile, OSError):
        raise ExtractError("corrupt", f"The file is not a valid {label} document.") from None
    with zf:
        names = {n.lower().replace("\\", "/"): n for n in zf.namelist()}
        pages = _page_order(zf, names)
        if not pages:
            raise ExtractError("corrupt", f"The file is not a valid {label} document (no pages).")
        job.meta["pageCount"] = len(pages)
        for number, name in enumerate(pages, 1):
            if job.out.full:
                job.out.mark_truncated()
                break
            try:
                with zf.open(name) as fh:
                    text = _page_text(fh)
            except ExtractError:
                raise
            except MemoryError:
                raise
            except Exception:
                continue  # an unreadable page does not spoil the others
            job.out.add_page(number, text)
