#!/bin/sh
# Containment + bridge test for the code-runner sandbox. Requires Docker; no
# local Deno needed. Builds the image, runs the integration test (spawn +
# setpriv + locked deno + harness + bridge) as root inside it, then exercises
# the end-to-end WebSocket path the backend uses. Exits non-zero on any failure.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="amcp-code-runner:test"

echo "== building $IMAGE"
docker build -t "$IMAGE" "$DIR" >/dev/null

echo "== containment + bridge (in-image integration test)"
docker run --rm --network none -v "$DIR":/opt/code-runner:ro --entrypoint sh "$IMAGE" -c '
  cp -r /opt/code-runner /opt/cr && cd /opt/cr &&
  DENO_DIR=/tmp/dd deno run \
    --allow-run=/usr/bin/setpriv \
    --allow-read=/opt/cr,/opt/code-runner,/tmp/code-runner \
    --allow-write=/tmp/code-runner \
    --allow-sys=uid,gid --allow-env \
    /opt/cr/containment-test.js'

echo "== end-to-end WebSocket (backend -> supervisor -> child)"
NAME="amcp-cr-test-$$"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 18777:8777 "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:18777 >/dev/null 2>&1 && break; sleep 0.5; done
docker run --rm --network host -v "$DIR":/w:ro --entrypoint deno "$IMAGE" \
  run --allow-net /w/e2e-client.js 18777 \
  'const x = await amcp.run("demo_echo",{a:2}); console.log("got", x); return x.echoed.a + 40;'

echo "== all code-runner tests passed"
