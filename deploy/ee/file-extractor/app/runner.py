# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Parent-process side: run one extraction in a killable child process."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import signal

from .errors import error_result

_CTX = multiprocessing.get_context("spawn")


def _kill(proc) -> None:
    """Kill the child and everything it started (its process group)."""
    pid = proc.pid
    if pid is not None and hasattr(os, "killpg"):
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.kill()
    except (ProcessLookupError, OSError, ValueError):
        pass


async def run_job(spec: dict, timeout: float) -> dict:
    """Run ``worker.child_main`` with a deadline; always returns a result."""
    from . import worker

    result_path = os.path.join(spec["workdir"], "result.json")
    proc = _CTX.Process(target=worker.child_main, args=(spec, result_path), daemon=True)
    await asyncio.to_thread(proc.start)
    try:
        await asyncio.to_thread(proc.join, timeout)
        if proc.is_alive():
            _kill(proc)
            await asyncio.to_thread(proc.join, 5)
            return error_result("timeout", f"Reading the document took longer than {timeout:g} seconds.")
        # No group kill here: the child has been reaped, so its pid (and
        # group id) may already belong to another job. Helper tools are
        # always waited for (or killed) by subprocess.run inside the child.
        try:
            with open(result_path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            pass
        if proc.exitcode == -signal.SIGKILL:
            return error_result("too_large", "The document needs more memory than the extractor allows.")
        return error_result("corrupt", "The document could not be read (the extractor stopped unexpectedly).")
    finally:
        if proc.is_alive():
            _kill(proc)
        try:
            proc.close()
        except ValueError:
            pass
