import { Injectable, Logger } from '@nestjs/common';

/**
 * CodeExecutorService — the backend half of code mode.
 *
 * It connects to the out-of-process `code-runner` (deploy/code-runner), sends a
 * run, answers the sandbox's `amcp.*` bridge calls, and returns the result. It
 * holds NO sandbox of its own: code never runs in this process. When no runner
 * is configured or it cannot be reached, a run is refused — never executed
 * locally.
 *
 * Policy (which tools a run may call, read vs write, the caller's role scope)
 * lives in the `CodeBridge` the caller supplies: `run`/`search`/`describe` are
 * wired by the caller to the existing `executeTool` path, so a code run can do
 * exactly what the same caller could do with direct MCP calls, and no more.
 * This service only moves messages and enforces the transport-level ceilings
 * (deadline, bridge-call count) as defence in depth behind the sandbox's own.
 */

/** The capability a code run is given. The caller decides what each may do. */
export interface CodeBridge {
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
  describe(tool: string): Promise<unknown>;
  run(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface CodeRunInput {
  code: string;
  deadlineMs?: number;
  bridge: CodeBridge;
}

export interface CodeLogLine {
  level: string;
  message: string;
}

export interface CodeRunResult {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; stack?: string };
  logs: CodeLogLine[];
  /** Tool calls the run made, for the audit row (name + read/write is the caller's). */
  calls: { fn: string; tool?: string }[];
  durationMs: number;
}

/** A minimal duplex to the runner. Swappable so tests need no real socket. */
export interface RunnerChannel {
  send(message: unknown): void;
  onMessage(handler: (message: any) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

const DEFAULT_DEADLINE_MS = 10_000;
const MAX_DEADLINE_MS = 30_000;
/** Client-side grace over the deadline: the supervisor kills first; this is a backstop. */
const CONNECT_TIMEOUT_MS = 5_000;
const CLIENT_GRACE_MS = 5_000;
const MAX_BRIDGE_CALLS = 500;

@Injectable()
export class CodeExecutorService {
  private readonly logger = new Logger(CodeExecutorService.name);

  /** True when a runner is configured. Callers gate the feature on this. */
  isConfigured(): boolean {
    return !!this.runnerUrl();
  }

  private runnerUrl(): string | undefined {
    const url = process.env.CODE_RUNNER_URL;
    return url && url.trim() ? url.trim() : undefined;
  }

  private clampDeadline(ms: number | undefined): number {
    if (!Number.isFinite(ms as number) || (ms as number) <= 0) return DEFAULT_DEADLINE_MS;
    return Math.min(Math.floor(ms as number), MAX_DEADLINE_MS);
  }

  /**
   * Open a channel to the runner. Overridable in tests. Default: a WebSocket
   * (Node 22+ global client), with a connect timeout so a dead runner fails
   * fast instead of hanging the run.
   */
  protected async connect(url: string): Promise<RunnerChannel> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`code-runner did not accept a connection within ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('code-runner connection failed'));
      });
    });
    return {
      send: (message) => ws.send(JSON.stringify(message)),
      onMessage: (handler) =>
        ws.addEventListener('message', (ev: MessageEvent) => {
          let msg: unknown;
          try {
            msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
          } catch {
            return;
          }
          handler(msg);
        }),
      onClose: (handler) => ws.addEventListener('close', () => handler()),
      close: () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
  }

  async run(input: CodeRunInput): Promise<CodeRunResult> {
    const start = Date.now();
    const logs: CodeLogLine[] = [];
    const calls: { fn: string; tool?: string }[] = [];
    const deadlineMs = this.clampDeadline(input.deadlineMs);

    const url = this.runnerUrl();
    if (!url) {
      return {
        ok: false,
        error: { name: 'Unavailable', message: 'Code mode is not available on this instance (no code-runner configured).' },
        logs,
        calls,
        durationMs: 0,
      };
    }

    let channel: RunnerChannel;
    try {
      channel = await this.connect(url);
    } catch (err: any) {
      this.logger.warn(`code-runner unreachable: ${err?.message ?? err}`);
      return {
        ok: false,
        error: { name: 'Unavailable', message: 'Code mode is temporarily unavailable: the code-runner could not be reached.' },
        logs,
        calls,
        durationMs: Date.now() - start,
      };
    }

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false;
      let bridgeCalls = 0;

      const finish = (result: Omit<CodeRunResult, 'logs' | 'calls' | 'durationMs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        channel.close();
        resolve({ ...result, logs, calls, durationMs: Date.now() - start });
      };

      // Backstop: the supervisor enforces the deadline and kills the child, but
      // if the whole runner went away mid-run we must not hang forever.
      const backstop = setTimeout(() => {
        finish({ ok: false, error: { name: 'TimeoutError', message: `code run exceeded ${deadlineMs} ms` } });
      }, deadlineMs + CLIENT_GRACE_MS);

      const answer = async (msg: { id: number; fn: string; args: unknown[] }) => {
        bridgeCalls += 1;
        if (bridgeCalls > MAX_BRIDGE_CALLS) {
          channel.send({ t: 'callResult', id: msg.id, ok: false, error: `exceeded ${MAX_BRIDGE_CALLS} tool calls` });
          return;
        }
        const args = Array.isArray(msg.args) ? msg.args : [];
        try {
          let value: unknown;
          if (msg.fn === 'search') {
            calls.push({ fn: 'search' });
            value = await input.bridge.search(String(args[0] ?? ''), (args[1] as Record<string, unknown>) ?? {});
          } else if (msg.fn === 'describe') {
            calls.push({ fn: 'describe', tool: String(args[0] ?? '') });
            value = await input.bridge.describe(String(args[0] ?? ''));
          } else if (msg.fn === 'run') {
            calls.push({ fn: 'run', tool: String(args[0] ?? '') });
            value = await input.bridge.run(String(args[0] ?? ''), (args[1] as Record<string, unknown>) ?? {});
          } else {
            channel.send({ t: 'callResult', id: msg.id, ok: false, error: `unknown bridge function '${msg.fn}'` });
            return;
          }
          channel.send({ t: 'callResult', id: msg.id, ok: true, value });
        } catch (err: any) {
          // The tool failed (or was refused by role/scope): the sandbox sees it
          // as a thrown error inside amcp.run, exactly like a direct call.
          channel.send({ t: 'callResult', id: msg.id, ok: false, error: String(err?.message ?? err) });
        }
      };

      channel.onMessage((msg: any) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'call') {
          void answer(msg);
        } else if (msg.t === 'log') {
          if (logs.length < 1000) logs.push({ level: String(msg.level ?? 'log'), message: String(msg.message ?? '') });
        } else if (msg.t === 'result') {
          finish(
            msg.ok
              ? { ok: true, value: msg.value }
              : { ok: false, error: msg.error ?? { name: 'Error', message: 'code run failed' } },
          );
        }
      });

      channel.onClose(() => {
        finish({ ok: false, error: { name: 'Error', message: 'the code-runner closed the connection before the run finished' } });
      });

      channel.send({ t: 'job', code: input.code, deadlineMs });
    });
  }
}
