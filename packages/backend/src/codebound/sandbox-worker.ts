// The worker runs only this trusted harness. User source is evaluated solely
// inside QuickJS/WASM; no Node object or function crosses that boundary.
export const SANDBOX_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { getQuickJS } = require(workerData.quickjsPath);

(async () => {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= workerData.deadline);
  // No module loader, network, process, filesystem, timers, or Node globals.
  const vm = runtime.newContext();
  const pending = new Map();
  let sequence = 0;
  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    parentPort.postMessage(message);
  };
  const pump = () => {
    if (finished) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      jobs.error.dispose();
      finish({ type: 'error', error: 'Script execution failed or exceeded its resource limit.' });
    }
  };
  const call = vm.newFunction('call', (payload) => {
    if (vm.typeof(payload) !== 'string') throw new Error('Invalid tool call.');
    const text = vm.getString(payload);
    if (Buffer.byteLength(text) > 65536) throw new Error('Tool arguments exceed 64 KiB.');
    const deferred = vm.newPromise();
    const id = ++sequence;
    pending.set(id, deferred);
    parentPort.postMessage({ type: 'call', id, payload: text });
    return deferred.handle;
  });
  const done = vm.newFunction('done', (result) => {
    if (vm.typeof(result) !== 'string') {
      finish({ type: 'error', error: 'Return a JSON value.' });
    } else {
      const json = vm.getString(result);
      if (Buffer.byteLength(json) > 32768) finish({ type: 'error', error: 'Script output exceeds 32 KiB.' });
      else finish({ type: 'result', json });
    }
  });
  const fail = vm.newFunction('fail', (message) => {
    const text = vm.typeof(message) === 'string' ? vm.getString(message) : 'Script failed.';
    finish({ type: 'error', error: text.slice(0, 500) });
  });
  vm.setProp(vm.global, '__call', call);
  vm.setProp(vm.global, '__done', done);
  vm.setProp(vm.global, '__fail', fail);
  call.dispose(); done.dispose(); fail.dispose();
  parentPort.on('message', (message) => {
    if (finished) return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    // Resolve with serialized data; guest JSON.parse owns the resulting object.
    const value = vm.newString(message.json);
    deferred.resolve(value);
    value.dispose();
    deferred.dispose();
    pump();
  });
  // Capture the bridge and JSON intrinsics before running user code, then hide
  // bridge globals. User code receives only input and tools.call(name, args).
  const bootstrap = vm.evalCode(
    '(function(call, done, fail, parse, stringify) {' +
    'delete globalThis.__call; delete globalThis.__done; delete globalThis.__fail;' +
    'const tools = Object.freeze({call: async (name, args) => {' +
    'const reply = parse(await call(stringify({name, args})));' +
    'if (!reply.ok) throw new Error(reply.error); return reply.value;' +
    '}});' +
    'const input = parse(' + JSON.stringify(workerData.inputJson) + ');' +
    '(async function(input, tools) { "use strict";\n' + workerData.code +
    '\n})(input, tools).then(value => { try { done(stringify(value)); }' +
    'catch (_) { fail("Return a JSON-serializable value."); } },' +
    'error => { try { fail(String(error)); } catch (_) { fail("Script failed."); } });' +
    '})(__call, __done, __fail, JSON.parse, JSON.stringify);',
    'codebound.js'
  );
  if (bootstrap.error) {
    bootstrap.error.dispose();
    finish({ type: 'error', error: 'Script syntax error or resource limit exceeded.' });
  } else {
    bootstrap.value.dispose();
    pump();
  }
})().catch(() => parentPort.postMessage({ type: 'error', error: 'Sandbox could not start.' }));
`;
