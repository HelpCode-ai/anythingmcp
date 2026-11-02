# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Legacy binary Office formats through small C tools (antiword, catdoc).

The tools run without a shell, with a minimal environment, a timeout, and
their output written to a file in the job directory (never buffered
unbounded in memory).
"""

from __future__ import annotations

import os
import shutil
import subprocess

from ..errors import ExtractError
from ..job import Job
from ..textdecode import decode_bytes, read_capped


def run_tool(args: list[str], job: Job, out_path: str) -> tuple[int, str]:
    """Run ``args`` with stdout to ``out_path``; returns (exit code, stderr)."""
    if shutil.which(args[0], path="/usr/local/bin:/usr/bin:/bin") is None:
        return 127, f"{args[0]} is not installed"
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": job.workdir,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    err_path = out_path + ".err"
    try:
        with open(out_path, "wb") as out, open(err_path, "wb") as err:
            proc = subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                env=env,
                cwd=job.workdir,
                timeout=max(1.0, job.tool_timeout),
                close_fds=True,
                check=False,
            )
        code = proc.returncode
    except subprocess.TimeoutExpired:
        raise ExtractError("timeout", "Reading the document took too long.") from None
    except OSError:
        return 127, f"{args[0]} could not be started"
    try:
        with open(err_path, "rb") as fh:
            stderr = fh.read(4096).decode("utf-8", "replace")
    except OSError:
        stderr = ""
    return code, stderr


def _tool_text(job: Job, args: list[str]) -> tuple[str | None, str, bool]:
    out_path = job.scratch_path(".txt")
    code, stderr = run_tool(args, job, out_path)
    try:
        data, more = read_capped(out_path, job.max_chars)
    except OSError:
        data, more = b"", False
    finally:
        for path in (out_path, out_path + ".err"):
            try:
                os.unlink(path)
            except OSError:
                pass
    if code != 0 or not data.strip():
        return None, stderr, False
    return decode_bytes(data), stderr, more


def _add_flow(job: Job, text: str, more: bool) -> None:
    for paragraph in text.split("\n\n"):
        if job.out.full:
            job.out.mark_truncated()
            break
        job.out.add_block(paragraph.replace("\f", "\n"))
    if more:
        job.out.mark_truncated()


def extract_doc(job: Job) -> None:
    text, stderr, more = _tool_text(job, ["antiword", "-m", "UTF-8.txt", "-w", "0", job.path])
    if text is None:
        if "encrypt" in stderr.lower():
            raise ExtractError("encrypted", "The Word document is password-protected.")
        text, stderr2, more = _tool_text(job, ["catdoc", "-d", "utf-8", "-w", job.path])
        if text is None:
            if "encrypt" in (stderr + stderr2).lower():
                raise ExtractError("encrypted", "The Word document is password-protected.")
            raise ExtractError("corrupt", "The file is not a readable Word document.")
    _add_flow(job, text, more)


def extract_ppt(job: Job) -> None:
    """catppt separates text blocks with form feeds, but those blocks are not
    reliable slides (masters and notes are emitted the same way, sometimes
    repeating slide text), so .ppt text is returned as ``page: null``
    segments, with repeated blocks dropped."""
    text, stderr, more = _tool_text(job, ["catppt", "-d", "utf-8", job.path])
    if text is None:
        if "encrypt" in stderr.lower():
            raise ExtractError("encrypted", "The PowerPoint file is password-protected.")
        raise ExtractError("corrupt", "The file is not a readable PowerPoint file.")
    seen: set[str] = set()
    blocks = []
    for block in text.split("\f"):
        key = block.strip()
        if key and key not in seen:
            seen.add(key)
            blocks.append(block)
    _add_flow(job, "\n\n".join(blocks), more)
