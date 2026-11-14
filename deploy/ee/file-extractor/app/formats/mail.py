# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""E-mail: Outlook .msg (extract-msg), RFC 822 .eml and .mbox (stdlib ``email``).

Layout of the text, in ``page: null`` segments::

    From: ...
    To: ...
    Cc: ...
    Date: ...
    Subject: ...
    Attachments: a.pdf, b.xlsx

    <body: plain text, else HTML converted to text>

    --- Attachment: a.pdf ---
    <text of the attachment>

Attachments are extracted one level deep through the same pipeline (only
supported types, nested mails skipped), with all attachment text together
capped at ``ATTACHMENT_TEXT_CAP`` characters. Signed, encrypted or broken
messages never fail the whole document: what could be read is returned.
"""

from __future__ import annotations

import os
from typing import Iterable

from ..errors import ExtractError
from ..job import Job
from .text import add_flow_text, html_to_text

ATTACHMENT_TEXT_CAP = 200_000
_NESTED_MAIL = {"msg", "eml", "mbox"}


def _ext_of(name: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/"))
    _, ext = os.path.splitext(base)
    return ext[1:].lower()


def _safe(getter, default=None):
    try:
        value = getter()
    except Exception:
        return default
    return default if value is None else value


def _header_block(fields: Iterable[tuple[str, object]], attachment_names: list[str]) -> str:
    lines = []
    for label, value in fields:
        text = " ".join(str(value).split()) if value not in (None, "") else ""
        if text:
            lines.append(f"{label}: {text[:2000]}")
    if attachment_names:
        lines.append("Attachments: " + ", ".join(n[:200] for n in attachment_names[:100]))
    return "\n".join(lines)


def _attachment_texts(job: Job, attachments: Iterable[tuple[str, bytes]]) -> list[tuple[str, str]]:
    """Run each supported attachment through the pipeline as a sub-job."""
    from . import SUPPORTED_EXTENSIONS, run_extraction

    results: list[tuple[str, str]] = []
    budget = ATTACHMENT_TEXT_CAP
    for name, data in attachments:
        if budget <= 0 or job.out.full:
            break
        ext = _ext_of(name)
        if not data or ext not in SUPPORTED_EXTENSIONS or ext in _NESTED_MAIL:
            continue
        path = job.scratch_path("." + ext)  # ext is allow-listed above
        try:
            with open(path, "wb") as fh:
                fh.write(data)
            sub = job.sub_job(path, ext, name, max_chars=budget)
            run_extraction(sub)
            job.ocr_pages += sub.ocr_pages
            text = sub.out.all_text().strip()
        except ExtractError as exc:
            if exc.kind == "timeout":
                raise
            continue
        except MemoryError:
            raise
        except Exception:
            continue
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        if text:
            results.append((name, text))
            budget -= len(text)
    return results


def _emit(job: Job, header: str, body: str, attachments: list[tuple[str, str]]) -> None:
    if header:
        job.out.add_block(header)
        job.out.add_break()
    if body:
        add_flow_text(job, body)
    for name, text in attachments:
        if job.out.full:
            job.out.mark_truncated()
            break
        job.out.add_break()
        job.out.add_block(f"--- Attachment: {name} ---")
        add_flow_text(job, text)


# -- .eml -------------------------------------------------------------------------

def _part_text(part) -> str:
    try:
        content = part.get_content()
        if isinstance(content, str):
            return content
    except Exception:
        pass
    from ..textdecode import decode_bytes

    payload = _safe(lambda: part.get_payload(decode=True), b"")
    return decode_bytes(payload) if isinstance(payload, bytes) else ""


def _walk_eml(part, found: dict) -> None:
    ctype = (part.get_content_type() or "").lower()
    if ctype == "message/rfc822":
        name = _safe(part.get_filename) or "attached message"
        found["names"].append(name)  # nested mails are listed, not read
        return
    if part.is_multipart():
        for sub in _safe(lambda: list(part.iter_parts()), []):
            _walk_eml(sub, found)
        return
    filename = _safe(part.get_filename)
    disposition = _safe(part.get_content_disposition)
    if filename or disposition == "attachment":
        name = filename or "unnamed attachment"
        found["names"].append(name)
        if ctype in ("application/pkcs7-signature", "application/x-pkcs7-signature"):
            return
        payload = _safe(lambda: part.get_payload(decode=True), b"")
        if isinstance(payload, bytes):
            found["files"].append((name, payload))
        return
    if ctype == "text/plain" and found["plain"] is None:
        found["plain"] = part
    elif ctype == "text/html" and found["html"] is None:
        found["html"] = part


def _eml_message(message) -> tuple[str, str, list[str], list[tuple[str, bytes]], object, object]:
    """Header block, body text, attachment names and files, subject, sender."""

    def header(name: str):
        return _safe(lambda: message.get(name))

    found = {"plain": None, "html": None, "names": [], "files": []}
    _walk_eml(message, found)
    if found["plain"] is not None:
        body = _part_text(found["plain"])
    elif found["html"] is not None:
        body, _title = html_to_text(_part_text(found["html"]))
    else:
        body = ""
    subject = header("Subject")
    sender = header("From")
    head = _header_block(
        [("From", sender), ("To", header("To")), ("Cc", header("Cc")),
         ("Date", header("Date")), ("Subject", subject)],
        found["names"],
    )
    return head, body, found["names"], found["files"], subject, sender


def extract_eml(job: Job) -> None:
    from email import policy
    from email.parser import BytesParser

    try:
        with open(job.path, "rb") as fh:
            message = BytesParser(policy=policy.default).parse(fh)
    except Exception:
        raise ExtractError("corrupt", "The file is not a readable e-mail message.") from None

    head, body, _names, files, subject, sender = _eml_message(message)
    if subject:
        job.meta["title"] = " ".join(str(subject).split())[:500] or None
    if sender:
        job.meta["author"] = " ".join(str(sender).split())[:500] or None
    attachments = _attachment_texts(job, files)
    _emit(job, head, body, attachments)


# -- .mbox ------------------------------------------------------------------------

MAX_MBOX_MESSAGES = 20_000
# Bytes of one message that are parsed; the rest (large attachments) is skipped.
MAX_MBOX_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_MBOX_BODY_CHARS = 100_000
MAX_MBOX_LINE_BYTES = 1024 * 1024


def _mbox_messages(fh):
    """Yield the raw bytes of each message (capped) of an mbox stream.

    A message starts at a ``From `` line at the start of the file or after
    an empty line; ``>From `` quoting (mboxrd/mboxo) is undone.
    """
    current: list[bytes] | None = None
    size = 0
    previous_blank = True
    while True:
        line = fh.readline(MAX_MBOX_LINE_BYTES)
        if not line:
            break
        if line.startswith(b"From ") and previous_blank:
            if current is not None:
                yield b"".join(current)
            current, size = [], 0
            previous_blank = False
            continue
        previous_blank = line in (b"\n", b"\r\n")
        if current is None:
            if line.strip():
                raise ExtractError("corrupt", "The file is not a readable mailbox (mbox).")
            continue
        if size >= MAX_MBOX_MESSAGE_BYTES:
            continue
        if line.startswith(b">") and line.lstrip(b">").startswith(b"From "):
            line = line[1:]
        current.append(line)
        size += len(line)
    if current is not None:
        yield b"".join(current)


def extract_mbox(job: Job) -> None:
    """Each message is one numbered item: header lines and the text body.
    Attachments are listed by name but not read."""
    from email import policy
    from email.parser import BytesParser

    parser = BytesParser(policy=policy.default)
    count = 0
    with open(job.path, "rb") as fh:
        for raw in _mbox_messages(fh):
            if job.out.full or count >= MAX_MBOX_MESSAGES:
                job.out.mark_truncated()
                break
            count += 1
            try:
                message = parser.parsebytes(raw)
                head, body, _names, _files, _subject, _sender = _eml_message(message)
            except Exception:
                continue  # one broken message does not spoil the mailbox
            body = (body or "").strip()
            # Quoted replies make long threads repetitive; one message never
            # takes more than this (the item still counts, nothing is marked).
            body = body[:MAX_MBOX_BODY_CHARS]
            job.out.add_page(count, f"{head}\n\n{body}" if head else body)
    if count == 0:
        raise ExtractError("corrupt", "The file is not a readable mailbox (mbox).")
    job.meta["pageCount"] = count


# -- .msg -------------------------------------------------------------------------

def _msg_attachments(msg) -> tuple[list[str], list[tuple[str, bytes]]]:
    names: list[str] = []
    files: list[tuple[str, bytes]] = []
    for attachment in _safe(lambda: list(msg.attachments), []):
        name = (
            _safe(lambda a=attachment: a.longFilename)
            or _safe(lambda a=attachment: a.name)
            or _safe(lambda a=attachment: a.shortFilename)
            or _safe(lambda a=attachment: a.displayName)
            or "unnamed attachment"
        )
        name = str(name)
        names.append(name)
        data = _safe(lambda a=attachment: a.data)
        if isinstance(data, (bytes, bytearray)):
            files.append((name, bytes(data)))
        # Embedded messages (MSGFile objects) are listed but not read.
    return names, files


def extract_msg_file(job: Job) -> None:
    import extract_msg
    from extract_msg.enums import ErrorBehavior

    try:
        msg = extract_msg.openMsg(
            job.path,
            strict=False,
            delayAttachments=False,
            errorBehavior=ErrorBehavior.SUPPRESS_ALL,
        )
    except Exception:
        raise ExtractError("corrupt", "The file is not a readable Outlook message.") from None
    try:
        body = _safe(lambda: msg.body, "") or ""
        if not str(body).strip():
            html = _safe(lambda: msg.htmlBody)
            if isinstance(html, (bytes, bytearray)) and html:
                from ..textdecode import decode_bytes

                body, _title = html_to_text(decode_bytes(bytes(html)))
        subject = _safe(lambda: msg.subject)
        sender = _safe(lambda: msg.sender)
        if subject:
            job.meta["title"] = " ".join(str(subject).split())[:500] or None
        if sender:
            job.meta["author"] = " ".join(str(sender).split())[:500] or None
        names, files = _msg_attachments(msg)
        head = _header_block(
            [("From", sender), ("To", _safe(lambda: msg.to)), ("Cc", _safe(lambda: msg.cc)),
             ("Date", _safe(lambda: msg.date)), ("Subject", subject)],
            names,
        )
        attachments = _attachment_texts(job, files)
        _emit(job, head, str(body), attachments)
    finally:
        _safe(msg.close)
