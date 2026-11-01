# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
"""Optional OCR with RapidOCR (ONNX runtime, CPU).

Only present in images built with ``--build-arg OCR=1``. The engine is
created lazily inside the child process, once per extraction.
"""

from __future__ import annotations

import importlib.util
from functools import lru_cache


@lru_cache(maxsize=1)
def ocr_available() -> bool:
    try:
        return importlib.util.find_spec("rapidocr_onnxruntime") is not None
    except (ImportError, ValueError):
        return False


_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR()
    return _engine


def ocr_image(image) -> str:
    """Recognise text in a PIL image; returns lines top to bottom."""
    import numpy as np

    engine = _get_engine()
    # RapidOCR expects OpenCV's BGR channel order for arrays.
    array = np.asarray(image.convert("RGB"))[:, :, ::-1]
    result, _elapsed = engine(np.ascontiguousarray(array))
    if not result:
        return ""
    return "\n".join(str(item[1]) for item in result if len(item) > 1 and item[1])
