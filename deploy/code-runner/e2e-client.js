// End-to-end client: talks to the running code-runner container exactly as the
// backend will — opens a WebSocket, sends a job, answers the amcp bridge, prints
// the final result.
const port = Deno.args[0] ?? '8777';
const code = Deno.args[1] ?? 'const x = await amcp.run("demo_echo",{a:2}); console.log("got", x); return x.echoed.a + 40;';
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const out = { logs: [], calls: [] };
ws.onopen = () => ws.send(JSON.stringify({ t: 'job', runId: 'e2e', code, deadlineMs: 5000 }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === 'call') {
    out.calls.push(`${m.fn}`);
    const value = m.fn === 'run' ? { echoed: m.args[1] } : m.fn === 'search' ? [{ tool: 't' }] : {};
    ws.send(JSON.stringify({ t: 'callResult', id: m.id, ok: true, value }));
  } else if (m.t === 'log') {
    out.logs.push(m.message);
  } else if (m.t === 'result') {
    console.log(JSON.stringify({ result: m, ...out }));
    ws.close();
    Deno.exit(m.ok ? 0 : 1);
  }
};
ws.onerror = (e) => { console.log('ws error', e.message ?? e); Deno.exit(2); };
setTimeout(() => { console.log('client timeout'); Deno.exit(3); }, 10000);
