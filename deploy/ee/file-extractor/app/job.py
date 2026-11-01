# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""The state one extraction works on, inside the child process."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .errors import empty_meta
from .output import Output


@dataclass
class Job:
    path: str
    ext: str
    workdir: str
    max_chars: int
    # Original file name, only used as text (e.g. the CSV "sheet" name);
    # never used to build a path.
    name: str = ""
    ocr: bool = False
    tool_timeout: float = 60.0
    out: Output = None  # type: ignore[assignment]
    meta: dict = None  # type: ignore[assignment]
    ocr_pages: int = 0
    empty_pages: int = 0
    # Attachments of a mail are extracted as sub-jobs; nested mails are not.
    is_attachment: bool = False
    _counter: list = field(default_factory=lambda: [0])

    def __post_init__(self) -> None:
        if self.out is None:
            self.out = Output(self.max_chars)
        if self.meta is None:
            self.meta = empty_meta(self.ext or None)

    def scratch_path(self, suffix: str = ".bin") -> str:
        """A fresh file name inside the job's private temp directory.

        Names never come from the document, so a hostile attachment name
        cannot point outside the directory.
        """
        self._counter[0] += 1
        return os.path.join(self.workdir, f"part-{self._counter[0]}{suffix}")

    def sub_job(self, path: str, ext: str, name: str, max_chars: int) -> "Job":
        return Job(
            path=path,
            ext=ext,
            name=name,
            workdir=self.workdir,
            max_chars=max_chars,
            ocr=self.ocr,
            tool_timeout=self.tool_timeout,
            is_attachment=True,
            _counter=self._counter,
        )
