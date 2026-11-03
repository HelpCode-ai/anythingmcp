import {
  CodeExecutorService,
  type CodeBridge,
  type RunnerChannel,
} from './code-executor.service';

/**
 * A fake code-runner that implements the harness protocol in-process, so these
 * tests exercise the service's bridge handling, limits and result plumbing
 * without a real socket or container. The actual sandbox containment is covered
 * by deploy/code-runner/test.sh.
 */
class FakeChannel implements RunnerChannel {
  private msgHandler?: (m: any) => void;
  private closeHandler?: () => void;
  sent: any[] = [];
  closed = false;

  constructor(private readonly supervisor: (m: any, ch: FakeChannel) => void) {}

  send(message: any): void {
    this.sent.push(message);
    this.supervisor(message, this);
  }
  onMessage(handler: (m: any) => void): void {
    this.msgHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }
  emit(m: any): void {
    this.msgHandler?.(m);
  }
  emitClose(): void {
    this.closeHandler?.();
  }
}

/** Subclass that connects to a provided fake instead of a WebSocket. */
class TestExecutor extends CodeExecutorService {
  constructor(private readonly channel: FakeChannel) {
    super();
  }
  protected async connect(): Promise<RunnerChannel> {
    return this.channel;
  }
}

function bridge(overrides: Partial<CodeBridge> = {}): CodeBridge {
  return {
    search: async () => [{ tool: 'demo_echo' }],
    describe: async (t) => ({ name: t }),
    run: async (t, args) => ({ echoed: args }),
    ...overrides,
  };
}

describe('CodeExecutorService', () => {
  const OLD_URL = process.env.CODE_RUNNER_URL;
  beforeEach(() => {
    process.env.CODE_RUNNER_URL = 'ws://code-runner:8777';
  });
  afterEach(() => {
    if (OLD_URL === undefined) delete process.env.CODE_RUNNER_URL;
    else process.env.CODE_RUNNER_URL = OLD_URL;
  });

  it('refuses to run when no runner is configured (never runs in-process)', async () => {
    delete process.env.CODE_RUNNER_URL;
    const svc = new TestExecutor(new FakeChannel(() => {}));
    expect(svc.isConfigured()).toBe(false);
    const res = await svc.run({ code: 'return 1;', bridge: bridge() });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('Unavailable');
  });

  it('returns the run result and records a forwarded bridge call and logs', async () => {
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') {
        ch.emit({ t: 'log', level: 'log', message: 'hello' });
        ch.emit({ t: 'call', id: 1, fn: 'run', args: ['demo_echo', { a: 1 }] });
      } else if (m.t === 'callResult' && m.id === 1) {
        // echo the bridge value back as the run's result
        ch.emit({ t: 'result', ok: true, value: m.value });
      }
    });
    const svc = new TestExecutor(channel);
    const res = await svc.run({ code: 'return await amcp.run("demo_echo",{a:1});', bridge: bridge() });
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ echoed: { a: 1 } });
    expect(res.logs).toEqual([{ level: 'log', message: 'hello' }]);
    expect(res.calls).toEqual([{ fn: 'run', tool: 'demo_echo' }]);
    expect(channel.closed).toBe(true);
  });

  it('sends the job with a clamped deadline', async () => {
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') ch.emit({ t: 'result', ok: true, value: null });
    });
    const svc = new TestExecutor(channel);
    await svc.run({ code: 'return 1;', deadlineMs: 999_999, bridge: bridge() });
    const job = channel.sent.find((m) => m.t === 'job');
    expect(job.deadlineMs).toBe(30_000); // MAX_DEADLINE_MS
  });

  it('propagates a tool refusal into the sandbox as a failed call, run keeps going', async () => {
    const calls: any[] = [];
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') {
        ch.emit({ t: 'call', id: 1, fn: 'run', args: ['payments_charge', {}] });
      } else if (m.t === 'callResult') {
        calls.push(m);
        // the sandbox caught the error and returned a value instead
        ch.emit({ t: 'result', ok: true, value: 'handled' });
      }
    });
    const svc = new TestExecutor(channel);
    const res = await svc.run({
      code: 'try { await amcp.run("payments_charge",{}); } catch { return "handled"; }',
      bridge: bridge({
        run: async () => {
          throw new Error('Access denied: you do not have permission to use this tool.');
        },
      }),
    });
    expect(calls[0]).toMatchObject({ t: 'callResult', id: 1, ok: false });
    expect(calls[0].error).toContain('Access denied');
    expect(res.ok).toBe(true);
    expect(res.value).toBe('handled');
  });

  it('surfaces a sandbox error result', async () => {
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') ch.emit({ t: 'result', ok: false, error: { name: 'Error', message: 'boom' } });
    });
    const svc = new TestExecutor(channel);
    const res = await svc.run({ code: 'throw new Error("boom");', bridge: bridge() });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({ name: 'Error', message: 'boom' });
  });

  it('fails the run if the runner closes before a result', async () => {
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') ch.emitClose();
    });
    const svc = new TestExecutor(channel);
    const res = await svc.run({ code: 'return 1;', bridge: bridge() });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain('closed the connection');
  });

  it('caps the number of bridge calls', async () => {
    let refusal: any = null;
    const channel = new FakeChannel((m, ch) => {
      if (m.t === 'job') {
        for (let i = 1; i <= 501; i++) ch.emit({ t: 'call', id: i, fn: 'run', args: ['t', {}] });
      } else if (m.t === 'callResult' && !m.ok && m.error?.includes?.('tool calls')) {
        refusal = m;
        ch.emit({ t: 'result', ok: true, value: 'done' });
      }
    });
    const svc = new TestExecutor(channel);
    const res = await svc.run({ code: 'loop', bridge: bridge() });
    expect(refusal).not.toBeNull();
    expect(res.ok).toBe(true);
  });
});
