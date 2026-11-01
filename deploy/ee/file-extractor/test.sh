#!/bin/sh
# Licensed under the AnythingMCP Commercial License, see deploy/ee/LICENSE.
#
# Full test of the file-extractor:
#   1. pytest on the host in a uv-managed venv,
#   2. the same suite inside the image (Linux, antiword/catdoc present),
#      run read-only, without capabilities and without a network,
#   3. the hardened runtime container end to end over HTTP (curl),
#   4. proof that the container has no outbound network with --network none.
#
# Optional environment:
#   EXTRACTOR_SAMPLES_DIR  folder with extra real-world samples (*.msg, *.doc,
#                          *.ppt, *.xls) that cannot be generated; mounted into
#                          the test container read-only.
#   OCR=1                  also build and test the OCR variant.
#   UV                     path to uv (default: uv on PATH).
# Exits non-zero on the first failure. Leaves no containers running.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
UV="${UV:-uv}"
IMAGE="amcp-file-extractor:test"
SUITE_IMAGE="amcp-file-extractor:test-suite"
NAME="amcp-fx-test-$$"
NAME_OFFLINE="amcp-fx-offline-$$"
PORT=18890
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fx-test.XXXXXX")"
HARDENED="--read-only --tmpfs /tmp:rw,noexec,nosuid,size=1g --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g"

cleanup() {
  docker rm -f "$NAME" "$NAME_OFFLINE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "== 1/4 pytest on the host"
VENV="$DIR/.venv"
[ -x "$VENV/bin/python" ] || "$UV" venv -q -p 3.12 "$VENV"
VIRTUAL_ENV="$VENV" "$UV" pip install -q -r requirements.txt -r requirements-dev.txt
"$VENV/bin/python" -m pytest -q -rs

echo "== 2/4 build images and run pytest inside the hardened container"
docker build -q -t "$IMAGE" . >/dev/null
docker build -q --target test -t "$SUITE_IMAGE" . >/dev/null
SAMPLES_ARGS=""
if [ -n "${EXTRACTOR_SAMPLES_DIR:-}" ]; then
  SAMPLES_ARGS="-v $EXTRACTOR_SAMPLES_DIR:/samples:ro -e EXTRACTOR_SAMPLES_DIR=/samples"
fi
# shellcheck disable=SC2086
docker run --rm $HARDENED --network none $SAMPLES_ARGS "$SUITE_IMAGE"

echo "== 3/4 hardened runtime container over HTTP"
TOKEN="$("$VENV/bin/python" -c 'import secrets; print(secrets.token_hex(24))')"
# shellcheck disable=SC2086
docker run -d --name "$NAME" $HARDENED -e EXTRACTOR_TOKEN="$TOKEN" \
  -p "127.0.0.1:$PORT:8890" "$IMAGE" >/dev/null
up=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] || { docker logs "$NAME"; echo "service did not come up"; exit 1; }

health="$(curl -sf "http://127.0.0.1:$PORT/health")"
echo "health: $health"
[ "$(docker exec "$NAME" id -u)" = "10001" ] || { echo "container does not run as uid 10001"; exit 1; }

"$VENV/bin/python" -m tests.samples xlsx "$WORK/preise.xlsx"
"$VENV/bin/python" -m tests.samples pdf "$WORK/katalog.pdf"

curl -sf -H "X-Extractor-Token: $TOKEN" -F "file=@$WORK/preise.xlsx" -F "filename=preise.xlsx" \
  "http://127.0.0.1:$PORT/extract" > "$WORK/xlsx.json"
curl -sf -H "X-Extractor-Token: $TOKEN" -F "file=@$WORK/katalog.pdf" -F "filename=katalog.pdf" \
  -F 'options={"ocr": false, "maxChars": 2000000}' "http://127.0.0.1:$PORT/extract" > "$WORK/pdf.json"
status="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Extractor-Token: wrong" \
  -F "file=@$WORK/katalog.pdf" -F "filename=katalog.pdf" "http://127.0.0.1:$PORT/extract")"

"$VENV/bin/python" - "$WORK/xlsx.json" "$WORK/pdf.json" "$status" "$health" <<'PY'
import json, sys
xlsx = json.load(open(sys.argv[1]))
pdf = json.load(open(sys.argv[2]))
status, health = sys.argv[3], json.loads(sys.argv[4])
assert xlsx["ok"] is True, xlsx
lines = "\n".join(p["text"] for p in xlsx["pages"]).split("\n")
want = 'Sheet "Preise" row 2: Artikel=NT-601 · Breite=875 · Preis=412 · Lieferdatum=2026-03-01'
assert want in lines, lines[:5]
assert xlsx["meta"]["sheetCount"] == 3, xlsx["meta"]
assert pdf["ok"] is True, pdf
assert [p["page"] for p in pdf["pages"]] == [1, 2], pdf["pages"]
assert "NT-601" in pdf["pages"][0]["text"]
assert pdf["meta"]["pageCount"] == 2
assert status == "401", status
assert health == {"ok": True, "ocr": False, "version": "1"}, health
print("http checks: xlsx row rendering, pdf page numbers, 401 on wrong token, health: OK")
PY
echo "== container log (metadata only, no content):"
docker logs "$NAME" 2>&1 | tail -5
docker rm -f "$NAME" >/dev/null

echo "== 4/4 no outbound network with --network none"
# shellcheck disable=SC2086
docker run -d --name "$NAME_OFFLINE" $HARDENED --network none -e EXTRACTOR_TOKEN="$TOKEN" "$IMAGE" >/dev/null
sleep 3
if docker exec "$NAME_OFFLINE" python -c "
import socket
socket.create_connection(('1.1.1.1', 443), timeout=3)
" >/dev/null 2>&1; then
  echo "FAIL: outbound connection succeeded"; exit 1
fi
echo "outbound TCP connection from the container fails: OK"
docker exec "$NAME_OFFLINE" python -c "
import urllib.request
print('in-container /health without network:', urllib.request.urlopen('http://127.0.0.1:8890/health', timeout=5).read().decode())
"
docker rm -f "$NAME_OFFLINE" >/dev/null

if [ "${OCR:-0}" = "1" ]; then
  echo "== OCR variant: build and run the OCR test inside it"
  docker build -q --build-arg OCR=1 -t "$IMAGE-ocr" . >/dev/null
  docker build -q --build-arg OCR=1 --target test -t "$SUITE_IMAGE-ocr" . >/dev/null
  # shellcheck disable=SC2086
  docker run --rm $HARDENED --network none "$SUITE_IMAGE-ocr" python -m pytest -q -rs -k "ocr or pdf or health"
fi

echo "== image size: $(docker image inspect --format '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1000/1000}')"
echo "== all file-extractor tests passed"
