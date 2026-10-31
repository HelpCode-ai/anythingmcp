# Code-runner: an isolated container that executes AnythingMCP "code mode" runs.
#
# The image carries a trusted supervisor and a locked-down harness. The
# supervisor (PID 1, root) accepts one WebSocket per run from the backend over
# the internal docker network and spawns ONE Deno subprocess per run, dropping
# to an unprivileged uid with a cleared environment. The subprocess runs the
# user's code with every Deno permission denied and an import map that blocks
# every file/node/npm/remote specifier, so the only way out is the amcp bridge
# the supervisor shuttles back to the backend. See README.md for the model and
# the verification.
#
# Pinned by tag AND digest: the runner is the security boundary, so the exact
# bytes are fixed and upgraded deliberately. Digest is the multi-arch index for
# denoland/deno:debian-2.9.8 (2026-10-21), verified with
# `docker buildx imagetools inspect`.
#
# No `USER` instruction on purpose (Trivy AVD-DS-0002 is waived in .trivyignore):
# PID 1 (the supervisor) must run as root so
# it can `setpriv` DOWN to the unprivileged `sandbox` uid for each run — a
# non-root PID 1 could not change the child's uid. The container is run with
# `cap_drop: ALL` (only SETUID/SETGID kept), `read_only`, `no-new-privileges`
# and no egress (see docker-compose.yml and README.md), and the untrusted code
# itself always runs as uid 10001, never root.
FROM denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0

# setpriv (util-linux) drops privileges per run; coreutils provides `env -i`.
# Both are in the base debian image already; install only if missing so the
# build stays reproducible and offline-friendly.
RUN set -eu; \
    command -v setpriv >/dev/null 2>&1 && command -v env >/dev/null 2>&1 || ( \
      apt-get update && apt-get install -y --no-install-recommends util-linux coreutils && \
      rm -rf /var/lib/apt/lists/* \
    )

# The unprivileged identity the sandboxed child runs as. No login, no shell,
# owns nothing.
RUN groupadd --gid 10001 sandbox && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

COPY harness.js import-map.json supervisor.js /opt/code-runner/
# World-readable, root-owned: the child may execute them but never modify them.
RUN chmod 0444 /opt/code-runner/harness.js /opt/code-runner/import-map.json && \
    chmod 0444 /opt/code-runner/supervisor.js && \
    mkdir -p /tmp/code-runner && chmod 1777 /tmp/code-runner

ENV CODE_RUNNER_PORT=8777 \
    CODE_RUNNER_UID=10001 \
    CODE_RUNNER_GID=10001
EXPOSE 8777

# The supervisor runs as root (it must setpriv), but with a narrow Deno
# permission set of its own: listen on the one port, spawn only setpriv, read
# only its own directory, write only the per-run scratch dirs, read only the
# three env vars it needs. The child it spawns gets none of this.
ENTRYPOINT ["deno", "run", \
  "--allow-net=0.0.0.0:8777", \
  "--allow-run=/usr/bin/setpriv", \
  "--allow-read=/opt/code-runner,/tmp/code-runner", \
  "--allow-write=/tmp/code-runner", \
  "--allow-sys=uid,gid", \
  "--allow-env=CODE_RUNNER_PORT,CODE_RUNNER_UID,CODE_RUNNER_GID", \
  "/opt/code-runner/supervisor.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('CODE_RUNNER_PORT') ?? '8777')); Deno.exit(r.ok ? 0 : 1)" || exit 1
