// Integration test for the code-runner security core: runs real jobs through
// supervisor.runJob (spawn + setpriv + locked deno + harness + bridge) and
// asserts containment. Run inside the deno image as root.
import { runJob } from '/opt/code-runner/supervisor.js';

// Stub backend: answers the amcp bridge the way the real backend will.
function answer(call) {
  if (call.fn === 'search') return { ok: true, value: [{ tool: 'demo_echo', readOnly: true }] };
  if (call.fn === 'describe') return { ok: true, value: { name: call.args[0], inputSchema: {} } };
  if (call.fn === 'run') return { ok: true, value: { echoed: call.args[1] } };
  return { ok: false, error: 'unknown fn' };
}

async function run(code, deadlineMs = 8000) {
  const logs = [];
  const calls = [];
  const res = await runJob({ code, deadlineMs }, {
    onMessage: (m) => {
      if (m.t === 'log') logs.push(`${m.level}:${m.message}`);
      if (m.t === 'call') calls.push(`${m.fn}(${JSON.stringify(m.args)})`);
    },
    answer,
  });
  return { res, logs, calls };
}

const cases = [
  ['compute', 'return 2 + 40;', (r) => r.res.ok && r.res.value === 42],
  ['bridge_run', 'const x = await amcp.run("demo_echo", {a:1}); return x.echoed.a;', (r) => r.res.ok && r.res.value === 1],
  ['bridge_search', 'const t = await amcp.search("echo"); return t[0].tool;', (r) => r.res.ok && r.res.value === 'demo_echo'],
  ['console', 'console.log("hello", {n:1}); return 1;', (r) => r.res.ok && r.logs.some((l) => l.includes('hello'))],
  // containment — each MUST fail (ok:false) or the bridge value must be denied
  ['deny_fetch', 'return await fetch("https://example.com").then(r=>r.status);', (r) => !r.res.ok],
  ['deny_read', 'return Deno.readTextFileSync("/etc/passwd");', (r) => !r.res.ok],
  ['deny_env', 'return Deno.env.get("PATH");', (r) => !r.res.ok],
  ['deny_run', 'return new Deno.Command("id").outputSync().code;', (r) => !r.res.ok],
  ['deny_import_text', 'const m = await import("file:///etc/hostname",{with:{type:"text"}}); return m.default;', (r) => !r.res.ok],
  ['deny_import_json', 'const m = await import("file:///etc/hostname",{with:{type:"json"}}); return m.default;', (r) => !r.res.ok],
  ['deny_import_local', 'const m = await import("./x.js"); return 1;', (r) => !r.res.ok],
  ['deny_import_fn', 'const im = new Function("s","return import(s)"); const m = await im("file:///etc/hostname?x"); return 1;', (r) => !r.res.ok],
  ['deny_node_fs', 'const fs = await import("node:fs"); return fs.readFileSync("/etc/passwd","utf8");', (r) => !r.res.ok],
  ['deny_node_cp', 'const cp = await import("node:child_process"); return cp.execSync("id").toString();', (r) => !r.res.ok],
  ['deny_proc_environ', 'const m = await import("file:///proc/self/environ",{with:{type:"text"}}); return m.default;', (r) => !r.res.ok],
  ['deny_ffi', 'const l = Deno.dlopen("libc.so.6", {}); return 1;', (r) => !r.res.ok],
  ['timeout', 'while(true){}', (r) => !r.res.ok && r.res.error.name === 'TimeoutError', 2500],
  ['throw', 'throw new Error("boom");', (r) => !r.res.ok && r.res.error.message.includes('boom')],
  ['syntax', 'return (;', (r) => !r.res.ok],
];

let pass = 0;
let fail = 0;
for (const [name, code, check, deadline] of cases) {
  let r;
  try {
    r = await run(code, deadline ?? 8000);
  } catch (e) {
    console.log(`FAIL ${name}: threw ${e}`);
    fail++;
    continue;
  }
  let ok;
  try {
    ok = check(r);
  } catch {
    ok = false;
  }
  if (ok) {
    pass++;
    console.log(`pass ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}: ${JSON.stringify(r.res)} logs=${JSON.stringify(r.logs)}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);
