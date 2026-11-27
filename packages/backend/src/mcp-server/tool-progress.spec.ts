import type { ServerContext } from '@modelcontextprotocol/server';
import { TOOL_PROGRESS_INTERVAL_MS, withToolProgress } from './tool-progress';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function caller(token: unknown = 'request-a') {
  const controller = new AbortController();
  const notify = jest.fn().mockResolvedValue(undefined);
  const context = { mcpReq: { signal: controller.signal, _meta: { progressToken: token }, notify } } as unknown as ServerContext;
  return { controller, notify, context };
}

describe('elapsed tool progress', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([0, '', 'opaque-token'])('echoes the exact token %p and only elapsed time', async (token) => {
    const { context, notify } = caller(token);
    const work = deferred<object>();
    const value = { credential: 'synthetic-private-value' };
    const result = withToolProgress(context, true, () => work.promise);
    await jest.advanceTimersByTimeAsync(TOOL_PROGRESS_INTERVAL_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenLastCalledWith({
      method: 'notifications/progress',
      params: { progressToken: token, progress: 5, message: 'Running for 5 seconds' },
    });
    await jest.advanceTimersByTimeAsync(TOOL_PROGRESS_INTERVAL_MS);
    expect(notify.mock.calls[1][0].params.progress).toBe(10);
    expect(JSON.stringify(notify.mock.calls)).not.toContain(value.credential);
    work.resolve(value);
    await expect(result).resolves.toBe(value);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, true, {}, NaN, Infinity])('creates no timer for invalid/missing token %p', async (token) => {
    const { context, notify } = caller(token);
    // Passing undefined explicitly must not select caller()'s default token.
    context.mcpReq._meta = { progressToken: token } as ServerContext['mcpReq']['_meta'];
    await expect(withToolProgress(context, true, () => 42)).resolves.toBe(42);
    expect(jest.getTimerCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does no progress work in JSON mode, even when a token is present', async () => {
    const { context, notify } = caller();
    const work = deferred<number>();
    const result = withToolProgress(context, false, () => work.promise);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    work.resolve(42);
    await expect(result).resolves.toBe(42);
  });

  it('preserves a synchronous failure and clears its timer', async () => {
    const error = new Error('upstream refused the call');
    await expect(withToolProgress(caller().context, true, () => { throw error; })).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up when a slow operation rejects', async () => {
    const { context, notify } = caller();
    const work = deferred<void>();
    const result = withToolProgress(context, true, () => work.promise);
    const error = new Error('upstream failed');
    const rejected = expect(result).rejects.toBe(error);
    await jest.advanceTimersByTimeAsync(5_000);
    work.reject(error);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on cancellation while the underlying call is still pending', async () => {
    const { context, controller, notify } = caller();
    const work = deferred<string>();
    const result = withToolProgress(context, true, () => work.promise);
    await jest.advanceTimersByTimeAsync(5_000);
    controller.abort();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledTimes(1);
    work.resolve('original result');
    await expect(result).resolves.toBe('original result');
  });

  it('creates no timer when the request is already cancelled', async () => {
    const { context, controller, notify } = caller();
    controller.abort();
    const operation = jest.fn().mockResolvedValue('unchanged');
    await expect(withToolProgress(context, true, operation)).resolves.toBe('unchanged');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not queue updates or hold the tool result behind a slow notification', async () => {
    const { context, notify } = caller();
    const work = deferred<string>();
    const delivery = deferred<void>();
    notify.mockReturnValue(delivery.promise);
    const result = withToolProgress(context, true, () => work.promise);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledTimes(1);
    work.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(jest.getTimerCount()).toBe(0);
    delivery.resolve();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'throw'])('ignores notification %s failures without changing the result', async (failure) => {
    const { context, notify } = caller();
    notify.mockImplementation(() => {
      if (failure === 'throw') throw new Error('closed stream');
      return Promise.reject(new Error('closed stream'));
    });
    const work = deferred<string>();
    const result = withToolProgress(context, true, () => work.promise);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(jest.getTimerCount()).toBe(0);
    work.resolve('done');
    await expect(result).resolves.toBe('done');
  });

  it('keeps concurrent callers independent', async () => {
    const a = caller('a'), b = caller(0);
    const first = deferred<void>(), second = deferred<void>();
    const one = withToolProgress(a.context, true, () => first.promise);
    const two = withToolProgress(b.context, true, () => second.promise);
    await jest.advanceTimersByTimeAsync(5_000);
    first.resolve();
    await one;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(a.notify).toHaveBeenCalledTimes(1);
    expect(b.notify.mock.calls.map(([event]) => event.params.progressToken)).toEqual([0, 0]);
    second.resolve();
    await two;
    expect(jest.getTimerCount()).toBe(0);
  });
});
