import { runSandbox } from './sandbox';

describe('Codebound QuickJS sandbox', () => {
  const call = jest.fn(async () => ({
    id: 1,
    title: 'Demo',
    body: 'Large intermediate response',
  }));
  beforeEach(() => call.mockClear());

  it('awaits a connector and returns only the selected fields', async () => {
    const result = await runSandbox(
      `
      const post = await tools.call('setup_demo_get_post', input);
      return { id: post.id, title: post.title };
    `,
      { postId: 1 },
      call,
    );
    expect(result).toEqual({ result: { id: 1, title: 'Demo' }, calls: 1 });
    expect(call).toHaveBeenCalledWith('setup_demo_get_post', { postId: 1 });
  });

  it('supports sequential calls and JSON parameters', async () => {
    expect(
      await runSandbox(
        `
      const first = await tools.call('a', {});
      const second = await tools.call('b', {});
      return first.id + second.id + input.extra;
    `,
        { extra: 3 },
        call,
      ),
    ).toEqual({ result: 5, calls: 2 });
  });

  it('provides no host capabilities, including through a Function constructor', async () => {
    const { result } = await runSandbox(
      `return {
      process: typeof process, require: typeof require, fetch: typeof fetch,
      Buffer: typeof Buffer, timers: typeof setTimeout,
      bridge: typeof __call,
      escape: Function('return typeof process')()
    };`,
      {},
      call,
    );
    expect(Object.values(result as object)).toEqual(Array(7).fill('undefined'));
    await expect(
      runSandbox(`return import('node:fs');`, {}, call),
    ).rejects.toThrow();
  });

  it('does not share globals between concurrent or sequential runs', async () => {
    const results = await Promise.all([
      runSandbox('globalThis.secret = "tenant-a"; return secret;', {}, call),
      runSandbox('return typeof secret;', {}, call),
    ]);
    expect(results.map((item) => item.result)).toEqual([
      'tenant-a',
      'undefined',
    ]);
    expect((await runSandbox('return typeof secret;', {}, call)).result).toBe(
      'undefined',
    );
  });

  it.each([
    ['synchronous loop', 'while (true) {}'],
    ['loop after await', 'await tools.call("a", {}); while (true) {}'],
    ['microtask loop', 'while (true) { await Promise.resolve(); }'],
    ['unresolved promise', 'await new Promise(() => {});'],
  ])('stops a %s and permits the next run', async (_name, code) => {
    await expect(runSandbox(code, {}, call, 300)).rejects.toThrow();
    expect((await runSandbox('return 42;', {}, call)).result).toBe(42);
  });

  it('stops excessive allocation', async () => {
    await expect(
      runSandbox(
        'const a = []; while (true) a.push(new Array(100000).fill(1));',
        {},
        call,
      ),
    ).rejects.toThrow();
  });

  it('limits tool calls even if the guest catches errors', async () => {
    await expect(
      runSandbox(
        `for (let i = 0; i < 30; i++) {
      try { await tools.call('a', {}); } catch (_) {}
    } return true;`,
        {},
        call,
      ),
    ).rejects.toThrow('20 tool call limit');
    expect(call).toHaveBeenCalledTimes(20);
  });

  it('requires sequential calls', async () => {
    await expect(
      runSandbox(
        `return Promise.all([tools.call('a', {}), tools.call('b', {})]);`,
        {},
        async () => new Promise(() => {}),
      ),
    ).rejects.toThrow('Await each tool call');
  });

  it('bounds output and cumulative intermediate data', async () => {
    await expect(
      runSandbox('return "x".repeat(32769);', {}, call),
    ).rejects.toThrow('32 KiB');
    await expect(
      runSandbox('return await tools.call("a", {});', {}, async () =>
        'x'.repeat(1024 * 1024),
      ),
    ).rejects.toThrow('1 MiB');
  });

  it('rejects oversized arguments and input', async () => {
    await expect(
      runSandbox(
        'return await tools.call("a", {x: "é".repeat(40000)});',
        {},
        call,
      ),
    ).rejects.toThrow('64 KiB');
    expect(() =>
      runSandbox('return input;', { data: 'x'.repeat(65536) }, call),
    ).toThrow('64 KiB');
  });

  it('rejects invalid JSON outputs and syntax', async () => {
    for (const code of [
      'return undefined;',
      'return 1n;',
      'const a = {}; a.a = a; return a;',
      'const = nope;',
    ]) {
      await expect(runSandbox(code, {}, call)).rejects.toThrow();
    }
  });

  it('does not expose raw host errors', async () => {
    await expect(
      runSandbox('return await tools.call("a", {});', {}, async () => {
        throw new Error('Credential secret-value');
      }),
    ).rejects.toThrow('Connector call failed.');
  });

  it('discards late results after timeout and makes no subsequent calls', async () => {
    let complete!: (value: unknown) => void;
    const slow = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await expect(
      runSandbox(
        'await tools.call("a", {}); return tools.call("b", {});',
        {},
        slow,
        300,
      ),
    ).rejects.toThrow();
    complete({ id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
