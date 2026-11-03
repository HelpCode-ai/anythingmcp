# Code-runner

An isolated container that executes AnythingMCP **code mode** runs: short
JavaScript programs an agent (or a saved code tool) submits, which orchestrate
several MCP tool calls in one round trip instead of the model making dozens.
The runner exists so that code — which is untrusted by construction, because a
prompt-injected tool result can steer what the agent writes — cannot touch
anything except the MCP tools the caller is already allowed to use.

This directory is the security boundary of the feature. Treat every change here
as a security change.

## What runs where

```
backend  ──WebSocket──▶  supervisor (PID 1, root)  ──spawn──▶  deno child (uid 10001)
 (trusted)              one per container, long-lived        one per run, locked down
   │                         │                                     │
   │  job + callResult       │  job + callResult (stdio)           │  runs user code,
   │◀── call / log / result ─┤◀── call / log / result ────────────┤  amcp.* is the
                                                                      only way out
```

- The **backend** opens one WebSocket per run to the supervisor over the
  internal docker network. It sends the code, answers every `amcp.*` call by
  running the real MCP tool **under the caller's role scope** (the same
  `executeTool` path, read/write gated exactly as a direct call), and receives
  the result. It is the only component that holds secrets, database access or
  egress.
- The **supervisor** (`supervisor.js`) is trusted and runs as root, but only so
  it can drop privileges. It never runs user code. Per run it spawns one Deno
  subprocess as the unprivileged `sandbox` uid with a cleared environment, pipes
  the job in over stdio, shuttles the bridge, and enforces the wall-clock
  deadline and output ceilings by killing the child.
- The **harness** (`harness.js`) is the entry module of that subprocess. It has
  no imports, wraps the user's code in an `AsyncFunction`, and exposes exactly
  one capability, `amcp` (`search`, `describe`, `run`). Everything else is
  denied by the runtime and the container.

## The containment model (defence in depth)

No single control is trusted alone. A file read, a network call or an
environment read must get past **all** of these:

1. **Deno permissions.** The child runs with `--deny-net --deny-read
   --deny-write --deny-env --deny-run --deny-ffi --deny-sys`, plus `--no-remote
   --no-npm --no-lock --cached-only --no-prompt --no-config`. The `node:`
   builtins (`fs`, `child_process`, `net`, `os`, …) honour the same permissions,
   so they are denied too.
2. **An import map that blocks every specifier.** `--deny-read` on its own does
   **not** stop `import('file:///etc/passwd', { with: { type: 'text' } })` or a
   plain `import('./x.js')` — Deno's module loader is a separate path from
   `Deno.readFile`. `import-map.json` remaps every `file:`, `node:`, `npm:`,
   `http:` and `https:` prefix onto a disabled remote URL, which `--no-remote`
   then refuses. This closes import-based file reads, including via relative
   specifiers, `new Function`, and `data:`/`blob:` module chains. Only the
   harness's own path is mapped to itself so the entry module still loads.
3. **An unprivileged uid with a cleared environment.** `setpriv` drops root to
   uid 10001 with no supplementary groups and `--no-new-privs`; `env -i` means
   the child's `/proc/self/environ` holds no secret and, critically, never the
   run token. Root-owned files (mode 600) stay unreadable even if a reader
   slipped past the layers above.
4. **The container.** No egress (the runner sits on an internal docker network
   and only accepts the backend's inbound WebSocket); a read-only, root-owned
   program directory; `--max-old-space-size=128` and a per-run deadline bound
   CPU and memory.

The run token travels in the WebSocket job, never in the environment or the
filesystem, so nothing the child can reach exposes it.

## Verification

`harness.js`, the Deno flags and the import map were verified against
`denoland/deno:debian-2.9.8` (2026-10-21) on 2026-10-31. The integration test
runs real jobs through `supervisor.runJob` (spawn + setpriv + locked deno +
harness + bridge) and asserts both that legitimate work succeeds and that every
escape attempt is contained:

- allowed: arithmetic, `amcp.run`/`amcp.search` over the bridge, `console`
  capture;
- denied: `fetch`, `Deno.readTextFile`, `Deno.env.get`, `Deno.Command`,
  `Deno.dlopen`, `import(... {type:'text'|'json'})`, relative `import()`,
  `import()` via `new Function`, `node:fs`, `node:child_process`, reading
  `/proc/self/environ`;
- enforced: wall-clock timeout kills a `while(true)` loop; thrown errors and
  syntax errors are reported as results, not crashes.

To re-run it (requires Docker; no local Deno needed):

```sh
./deploy/code-runner/test.sh
```

That builds the image, runs `containment-test.js` as root inside it (the
containment and bridge assertions above), then exercises the end-to-end
WebSocket path with `e2e-client.js`.

The end-to-end WebSocket path (backend ⇄ supervisor ⇄ child) was exercised with
a client that opens the socket, answers the bridge and reads the result: the
happy path returns the computed value with the bridge call forwarded and
`console` captured, and a `fetch` attempt comes back `ok: false` with
`NotCapable`.

## Deployment

The service is **off by default** in every deployment. It is enabled by running
the `code-runner` profile and pointing the backend at it:

```
COMPOSE_PROFILES=code-runner
CODE_RUNNER_URL=ws://code-runner:8777
```

On Cloud it runs as a dedicated service with its own CPU/memory limits; on
self-hosted it is the same image. The backend treats an unreachable runner as
"code mode unavailable" and falls back to refusing code runs, never to running
them in-process.

## Upgrading Deno

The base image is pinned by tag **and** digest. To upgrade: pick a new
`denoland/deno:debian-<version>` at least two weeks old, read its digest with
`docker buildx imagetools inspect`, update the `FROM` line, and re-run the
containment test before shipping. A Deno release can change the permission or
module-loader behaviour the model above depends on, so the test is the gate.
