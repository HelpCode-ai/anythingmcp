# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
#
# file-extractor: turns one uploaded document into plain text, page by page.
# Every byte it receives is treated as hostile; see README.md for the model.
#
# Build:            docker build -t anythingmcp-file-extractor .
# Build with OCR:   docker build --build-arg OCR=1 -t anythingmcp-file-extractor:ocr .
# Test-suite image: docker build --target test -t anythingmcp-file-extractor:test .
#
# Base pinned by tag AND digest (multi-arch index, verified with
# `docker buildx imagetools inspect python:3.12.16-slim-bookworm`).
FROM python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS runtime

ARG OCR=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp \
    TMPDIR=/tmp \
    PORT=8890

# antiword (.doc) and catdoc (catdoc/catppt/xls2csv) for legacy binary Office
# files. Nothing else from apt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends antiword catdoc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/file-extractor

# Fully pinned, hash-checked dependency sets (see README "Updating
# dependencies"); --no-deps because the lock files list every package.
COPY requirements.txt requirements-ocr.txt ./
RUN pip install --root-user-action=ignore --require-hashes --no-deps -r requirements.txt \
    && if [ "$OCR" = "1" ]; then \
         pip install --root-user-action=ignore --require-hashes --no-deps -r requirements-ocr.txt \
         && python -c "import rapidocr_onnxruntime"; \
       fi \
    && pip uninstall -y pip setuptools wheel >/dev/null 2>&1 || true

COPY app ./app
RUN python -m compileall -q app \
    && groupadd --gid 10001 extractor \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin extractor

EXPOSE 8890
USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8890/health', timeout=4).status == 200 else 1)"]

CMD ["python", "-m", "app"]


# Test-suite image: the runtime plus pytest and the fixture generators.
FROM runtime AS test
HEALTHCHECK NONE
USER root
COPY requirements-dev.txt ./
RUN python -m ensurepip >/dev/null 2>&1 \
    && python -m pip install --root-user-action=ignore --require-hashes --no-deps -r requirements-dev.txt
COPY pytest.ini ./
COPY tests ./tests
USER 10001:10001
CMD ["python", "-m", "pytest", "-q", "-rs"]


# Default target: the runtime image.
FROM runtime
