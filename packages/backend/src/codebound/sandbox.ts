import { Worker } from 'node:worker_threads';
import { SANDBOX_WORKER } from './sandbox-worker';

export const RUN_TIMEOUT_MS = 5000;
export const MAX_CALLS = 20;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export class ScriptError extends Error {}

/** Fresh worker and fresh QuickJS heap per run, including after failures. */
export function runSandbox(
  code: string,
  input: Record<string, unknown>,
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ result: unknown; calls: number }> {
  const inputJson = JSON.stringify(input);
  if (Buffer.byteLength(inputJson) > 65536)
    throw new ScriptError('Input exceeds 64 KiB.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(SANDBOX_WORKER, {
      eval: true,
      workerData: {
        code,
        inputJson,
        deadline: Date.now() + timeoutMs,
        quickjsPath: require.resolve('quickjs-emscripten'),
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      // Do not inherit ts-node loaders or other application startup flags.
      execArgv: [],
    });
    let settled = false;
    let calls = 0;
    let responseBytes = 0;
    let inFlight = false;
    const finish = (error?: ScriptError, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve({ result, calls });
      });
    };
    const timer = setTimeout(
      () => finish(new ScriptError('Script exceeded the 5 second time limit.')),
      timeoutMs,
    );
    worker.on('error', () =>
      finish(
        new ScriptError('Sandbox resource limit exceeded or worker failed.'),
      ),
    );
    worker.on('exit', () => {
      if (!settled) finish(new ScriptError('Sandbox exited without a result.'));
    });
    worker.on('message', async (message) => {
      if (settled) return;
      if (message.type === 'result') {
        try {
          finish(undefined, JSON.parse(message.json));
        } catch {
          finish(new ScriptError('Return a JSON value.'));
        }
        return;
      }
      if (message.type === 'error') {
        finish(new ScriptError(message.error));
        return;
      }
      if (message.type !== 'call') return;
      if (++calls > MAX_CALLS)
        return finish(
          new ScriptError('Script exceeded the 20 tool call limit.'),
        );
      // Existing connector engines cannot cancel a request. Limit the prototype
      // to sequential reads; after termination, never dispatch or deliver more.
      if (inFlight)
        return finish(
          new ScriptError('Await each tool call before starting the next.'),
        );
      inFlight = true;
      let reply: { ok: boolean; value?: unknown; error?: string };
      try {
        const { name, args } = JSON.parse(message.payload);
        if (
          typeof name !== 'string' ||
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args)
        ) {
          throw new ScriptError(
            'tools.call requires a tool name and an arguments object.',
          );
        }
        reply = { ok: true, value: await callTool(name, args) };
      } catch (error) {
        // Connector failures must never disclose credentials or raw exceptions.
        reply = {
          ok: false,
          error:
            error instanceof ScriptError
              ? error.message
              : 'Connector call failed.',
        };
      } finally {
        inFlight = false;
      }
      if (settled) return;
      try {
        const json = JSON.stringify(reply);
        responseBytes += Buffer.byteLength(json);
        if (responseBytes > MAX_RESPONSE_BYTES)
          return finish(
            new ScriptError('Tool responses exceed the 1 MiB run limit.'),
          );
        worker.postMessage({ id: message.id, json });
      } catch {
        finish(
          new ScriptError('Connector returned data that cannot be serialized.'),
        );
      }
    });
  });
}
