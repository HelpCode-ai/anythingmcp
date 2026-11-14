// Code-runner sandbox harness.
//
// Runs as the entry module of the locked-down Deno subprocess (one per run).
// It has NO imports on purpose: the sandbox import map blocks every file:,
// node:, npm:, jsr: and remote specifier, so anything this file imported would
// fail closed — and so would any import the user's code attempts.
//
// It speaks newline-delimited JSON with the supervisor over stdio:
//   stdin   host -> sandbox : one `job` message, then `callResult` messages
//   stdout  sandbox -> host : `call` and `log` messages, then one `result`
//   stderr  free-text diagnostics (never parsed; kept out of the protocol)
//
// The user's code is a single async function body. It is given one capability,
// `amcp`, whose methods are the ONLY way out of the sandbox: each call is sent
// to the host, which runs the real MCP tool under the caller's role scope and
// sends the value back. The sandbox never touches the network, the filesystem,
// the environment or a subprocess — those are denied at the Deno level and, in
// depth, by the container (non-root uid, cleared env, no egress).

'use strict';

const LIMITS = {
  maxCalls: 500, // total amcp.* calls per run
  maxConcurrentCalls: 16, // outstanding at once
  maxLogMessages: 1000,
  maxLogBytes: 64 * 1024, // total captured console output
  maxArgBytes: 256 * 1024, // per outbound call arguments, serialized
  maxResultBytes: 1024 * 1024, // the run's return value, serialized
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// Serialize writes to stdout: concurrent amcp calls and logs must not interleave
// half-lines. Each write chains onto the previous one's promise.
let writeChain = Promise.resolve();
function send(obj) {
  let line;
  try {
    line = JSON.stringify(obj);
  } catch {
    line = JSON.stringify({ t: 'result', ok: false, error: { name: 'Error', message: 'unserializable message' } });
  }
  const bytes = enc.encode(line + '\n');
  writeChain = writeChain.then(async () => {
    let off = 0;
    while (off < bytes.length) off += await Deno.stdout.write(bytes.subarray(off));
  });
  return writeChain;
}

// ── outbound calls to the host ────────────────────────────────────────────
let nextCallId = 1;
let callsMade = 0;
const pending = new Map(); // id -> { resolve, reject }

function hostCall(fn, args) {
  if (callsMade >= LIMITS.maxCalls) {
    return Promise.reject(new Error(`code run exceeded ${LIMITS.maxCalls} tool calls`));
  }
  if (pending.size >= LIMITS.maxConcurrentCalls) {
    return Promise.reject(new Error(`code run exceeded ${LIMITS.maxConcurrentCalls} concurrent tool calls`));
  }
  let serialized;
  try {
    serialized = JSON.stringify(args ?? []);
  } catch {
    return Promise.reject(new Error('tool-call arguments are not JSON-serializable'));
  }
  if (serialized.length > LIMITS.maxArgBytes) {
    return Promise.reject(new Error(`tool-call arguments exceed ${LIMITS.maxArgBytes} bytes`));
  }
  callsMade += 1;
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: 'call', id, fn, args: args ?? [] }).catch((e) => {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

// The one capability handed to user code. Thin by design: the host decides what
// each name may do (search/describe are read-only; run is gated read vs write by
// the caller's role, exactly like a direct MCP call).
const amcp = Object.freeze({
  search: (query, options) => hostCall('search', [query, options ?? {}]),
  describe: (tool) => hostCall('describe', [tool]),
  run: (tool, args) => hostCall('run', [tool, args ?? {}]),
});

// ── captured console ──────────────────────────────────────────────────────
let logMessages = 0;
let logBytes = 0;
function captureConsole(level) {
  return (...args) => {
    if (logMessages >= LIMITS.maxLogMessages || logBytes >= LIMITS.maxLogBytes) return;
    let text;
    try {
      text = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
    } catch {
      text = args.map((a) => String(a)).join(' ');
    }
    const remaining = LIMITS.maxLogBytes - logBytes;
    if (text.length > remaining) text = text.slice(0, remaining);
    logBytes += text.length;
    logMessages += 1;
    send({ t: 'log', level, message: text }).catch(() => {});
  };
}
const sandboxConsole = Object.freeze({
  log: captureConsole('log'),
  info: captureConsole('info'),
  warn: captureConsole('warn'),
  error: captureConsole('error'),
  debug: captureConsole('debug'),
});

// ── stdin: job + call results ─────────────────────────────────────────────
function handleCallResult(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.value);
  else entry.reject(new Error(typeof msg.error === 'string' ? msg.error : 'tool call failed'));
}

async function runUserCode(code) {
  // AsyncFunction: lets the body use top-level `await amcp.run(...)`. Any
  // import() the body attempts is still governed by the sandbox import map,
  // which blocks every file/node/npm/remote specifier.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction('amcp', 'console', `"use strict";\n${code}`);
  } catch (e) {
    return { ok: false, error: errShape(e, 'SyntaxError') };
  }
  try {
    const value = await fn(amcp, sandboxConsole);
    let serialized;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      return { ok: false, error: { name: 'TypeError', message: 'the return value is not JSON-serializable' } };
    }
    if (serialized.length > LIMITS.maxResultBytes) {
      return { ok: false, error: { name: 'Error', message: `the return value exceeds ${LIMITS.maxResultBytes} bytes` } };
    }
    return { ok: true, value: value ?? null };
  } catch (e) {
    return { ok: false, error: errShape(e, 'Error') };
  }
}

function errShape(e, fallbackName) {
  if (e instanceof Error) {
    return {
      name: e.name || fallbackName,
      message: String(e.message || e).slice(0, 2000),
      stack: typeof e.stack === 'string' ? e.stack.slice(0, 4000) : undefined,
    };
  }
  return { name: fallbackName, message: String(e).slice(0, 2000) };
}

async function main() {
  let buf = '';
  let started = false;
  let finished = false;

  const finish = async (result) => {
    if (finished) return;
    finished = true;
    await send({ t: 'result', ...result });
    // Reject anything still waiting so no promise keeps the process alive.
    for (const [, entry] of pending) entry.reject(new Error('run ended'));
    pending.clear();
    Deno.exit(0);
  };

  for await (const chunk of Deno.stdin.readable) {
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
        continue; // ignore malformed control lines
      }
      if (msg.t === 'job' && !started) {
        started = true;
        if (typeof msg.code !== 'string') {
          await finish({ ok: false, error: { name: 'Error', message: 'job carried no code' } });
          return;
        }
        // Run and report; do not return, keep reading stdin for callResults.
        runUserCode(msg.code).then(finish).catch((e) => finish({ ok: false, error: errShape(e, 'Error') }));
      } else if (msg.t === 'callResult') {
        handleCallResult(msg);
      }
    }
    if (finished) return;
  }
  // stdin closed before we produced a result.
  if (!finished) await finish({ ok: false, error: { name: 'Error', message: 'input stream closed before the run completed' } });
}

main().catch((e) => {
  try {
    Deno.stderr.writeSync(enc.encode(`harness fatal: ${e && e.stack ? e.stack : e}\n`));
  } catch {
    /* ignore */
  }
  Deno.exit(1);
});
