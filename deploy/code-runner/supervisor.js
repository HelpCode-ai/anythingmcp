// Code-runner supervisor.
//
// PID 1 of the `code-runner` container. Trusted: it runs as root, listens on an
// internal-only port, and spawns ONE locked-down Deno subprocess per run,
// dropping to an unprivileged uid with a cleared environment. It never runs the
// user's code itself — it only shuttles the harness protocol between the backend
// and the child, and enforces the wall-clock deadline and output ceilings that
// a misbehaving child could otherwise ignore.
//
// Transport: the backend opens a WebSocket to this supervisor (the runner has
// no outbound network; it only accepts this one inbound connection over the
// internal docker network). One run per socket:
//   backend -> supervisor : { t:'job', runId, code, deadlineMs }
//                           { t:'callResult', id, ok, value|error }
//   supervisor -> backend : { t:'call', id, fn, args }   (forwarded from child)
//                           { t:'log', level, message }   (forwarded from child)
//                           { t:'result', ok, value|error, meta }
// The backend answers each `call` by running the real MCP tool under the
// caller's role scope, then sends `callResult`. The socket closes after
// `result`.
//
// Run this with exactly the privileges it needs and nothing the child inherits:
//   deno run --allow-net=0.0.0.0:8777 --allow-run=/usr/bin/setpriv \
//            --allow-read=/opt/code-runner --allow-write=/tmp/code-runner \
//            --allow-env=CODE_RUNNER_PORT,CODE_RUNNER_UID,CODE_RUNNER_GID \
//            /opt/code-runner/supervisor.js

const HARNESS = '/opt/code-runner/harness.js';
const IMPORT_MAP = '/opt/code-runner/import-map.json';
// Absolute path to the deno binary: `env -i` clears PATH, so the child cannot
// resolve a bare `deno`. The supervisor's own interpreter is the one to reuse.
const DENO_BIN = Deno.execPath();
const PORT = Number(Deno.env.get('CODE_RUNNER_PORT') ?? '8777');
const UID = Number(Deno.env.get('CODE_RUNNER_UID') ?? '10001');
const GID = Number(Deno.env.get('CODE_RUNNER_GID') ?? '10001');

// Hard ceilings the supervisor enforces regardless of what the backend asks for.
const MAX_DEADLINE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 10_000;
const MAX_OLD_SPACE_MB = 128;

const DENY_FLAGS = [
  '--no-prompt',
  '--no-config',
  '--no-lock',
  '--no-npm',
  '--no-remote',
  '--cached-only',
  '--deny-net',
  '--deny-read',
  '--deny-write',
  '--deny-env',
  '--deny-run',
  '--deny-ffi',
  '--deny-sys',
  '--deny-import',
  `--import-map=${IMPORT_MAP}`,
  `--v8-flags=--max-old-space-size=${MAX_OLD_SPACE_MB}`,
];

const enc = new TextEncoder();
const dec = new TextDecoder();

function clampDeadline(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DEADLINE_MS;
  return Math.min(Math.floor(ms), MAX_DEADLINE_MS);
}

/**
 * Run one job to completion. Spawns the child, pipes the job in, forwards the
 * child's protocol messages to `onMessage`, and resolves with the final result.
 * `answer(callMsg)` is awaited for every `call` and must return a `callResult`.
 */
async function runJob(job, { onMessage, answer }) {
  const deadlineMs = clampDeadline(job.deadlineMs);
  const denoDir = `/tmp/code-runner/${crypto.randomUUID()}`;
  await Deno.mkdir(denoDir, { recursive: true });
  try {
    await Deno.chmod(denoDir, 0o700);
    // The child's DENO_DIR must be writable by the dropped uid (deno touches it
    // on start even with --no-remote); nothing secret lives there.
    await Deno.chown(denoDir, UID, GID);
  } catch {
    /* best effort on platforms without chown */
  }

  // setpriv drops root to the unprivileged uid with no supplementary groups and
  // no-new-privs; env -i clears the environment so no secret (and no runToken)
  // is ever visible to the child via /proc/self/environ. DENO_DIR is the only
  // variable set, to a per-run scratch dir.
  const command = new Deno.Command('/usr/bin/setpriv', {
    args: [
      `--reuid=${UID}`,
      `--regid=${GID}`,
      '--clear-groups',
      '--no-new-privs',
      '--',
      '/usr/bin/env',
      '-i',
      `DENO_DIR=${denoDir}`,
      DENO_BIN,
      'run',
      ...DENY_FLAGS,
      HARNESS,
    ],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    clearEnv: true,
  });

  const child = command.spawn();
  const writer = child.stdin.getWriter();
  let settled = false;
  let timedOut = false;

  const writeLine = async (obj) => {
    try {
      await writer.write(enc.encode(JSON.stringify(obj) + '\n'));
    } catch {
      /* child gone; the result path handles it */
    }
  };

  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, deadlineMs);

  // Feed the job first.
  await writeLine({ t: 'job', code: job.code, deadlineMs });

  let result = null;
  let buf = '';
  const readStdout = (async () => {
    for await (const chunk of child.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t === 'call') {
          onMessage?.(msg);
          // Answer out of band so a slow tool does not block other messages.
          Promise.resolve(answer(msg)).then((res) =>
            writeLine({ t: 'callResult', id: msg.id, ...res }),
          );
        } else if (msg.t === 'log') {
          onMessage?.(msg);
        } else if (msg.t === 'result') {
          result = msg;
          settled = true;
          onMessage?.(msg);
        }
      }
    }
  })();

  // Drain stderr so the pipe never blocks the child; keep a bounded tail.
  let stderrTail = '';
  const readStderr = (async () => {
    for await (const chunk of child.stderr) {
      stderrTail = (stderrTail + dec.decode(chunk, { stream: true })).slice(-4096);
    }
  })();

  const status = await child.status;
  clearTimeout(killTimer);
  try {
    await writer.close();
  } catch {
    /* already closed */
  }
  await Promise.allSettled([readStdout, readStderr]);
  await Deno.remove(denoDir, { recursive: true }).catch(() => {});

  if (result) return { ...result, meta: { exitCode: status.code } };
  if (timedOut) {
    return { t: 'result', ok: false, error: { name: 'TimeoutError', message: `run exceeded ${deadlineMs} ms` }, meta: { killed: true } };
  }
  return {
    t: 'result',
    ok: false,
    error: { name: 'Error', message: 'the sandbox exited without a result' },
    meta: { exitCode: status.code, stderr: stderrTail.slice(-1024) },
  };
}

// ── WebSocket transport ─────────────────────────────────────────────────────
function handleSocket(socket) {
  let answerResolvers = new Map();
  let job = null;

  const answer = (callMsg) =>
    new Promise((resolve) => {
      answerResolvers.set(callMsg.id, resolve);
      try {
        socket.send(JSON.stringify(callMsg));
      } catch {
        resolve({ ok: false, error: 'backend connection lost' });
      }
    });

  socket.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : dec.decode(ev.data));
    } catch {
      return;
    }
    if (msg.t === 'job' && !job) {
      job = msg;
      const final = await runJob(job, {
        onMessage: (m) => {
          if (m.t === 'call' || m.t === 'log') {
            // `call` is sent via answer() above; forward only logs here.
            if (m.t === 'log') {
              try {
                socket.send(JSON.stringify(m));
              } catch {
                /* ignore */
              }
            }
          }
        },
        answer,
      });
      try {
        socket.send(JSON.stringify(final));
      } catch {
        /* ignore */
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    } else if (msg.t === 'callResult') {
      const resolve = answerResolvers.get(msg.id);
      if (resolve) {
        answerResolvers.delete(msg.id);
        resolve({ ok: msg.ok, value: msg.value, error: msg.error });
      }
    }
  };
}

function main() {
  Deno.serve({ port: PORT, hostname: '0.0.0.0' }, (req) => {
    if (req.headers.get('upgrade') !== 'websocket') {
      // A plain GET is the container healthcheck.
      return new Response('code-runner ok\n', { status: 200 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  });
  console.error(`[code-runner] supervisor listening on :${PORT}, child uid=${UID}`);
}

if (import.meta.main) main();

export { runJob, clampDeadline, DENY_FLAGS };
