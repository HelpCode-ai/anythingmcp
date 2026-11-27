import type { RegisteredTool, ServerContext } from '@modelcontextprotocol/server';

/** Slow calls report elapsed seconds, never an estimated percentage or data. */
export const TOOL_PROGRESS_INTERVAL_MS = 5_000;

type RequestContext = Pick<ServerContext, 'mcpReq'>;

export async function withToolProgress<T>(
  context: RequestContext | undefined,
  enabled: boolean,
  operation: () => T | Promise<T>,
): Promise<T> {
  const request = context?.mcpReq;
  const token = request?._meta?.progressToken;
  if (
    !enabled || !request || typeof request.notify !== 'function' || request.signal.aborted ||
    !(typeof token === 'string' || (typeof token === 'number' && Number.isFinite(token)))
  ) return operation();

  const started = performance.now();
  let stopped = false;
  let sending = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    request.signal.removeEventListener('abort', stop);
  };
  const send = async () => {
    // A slow/disconnected reader must not accumulate pending notifications.
    if (stopped || sending) return;
    sending = true;
    const elapsed = Math.floor((performance.now() - started) / 1000);
    try {
      await request.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress: elapsed, message: `Running for ${elapsed} seconds` },
      });
    } catch {
      // Progress is best-effort; a closed stream must not fail the tool.
      stop();
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => { void send(); }, TOOL_PROGRESS_INTERVAL_MS);
  request.signal.addEventListener('abort', stop, { once: true });
  if (request.signal.aborted) stop();
  try {
    return await operation();
  } finally {
    stop();
  }
}

/** Full SDK registrations expose these; small controller test doubles may not. */
export type ProgressRegistration = Partial<Pick<RegisteredTool, 'inputSchema' | 'handler' | 'update'>>;
type Callback = NonNullable<Parameters<RegisteredTool['update']>[0]['callback']>;
type ContextOnlyCallback = (context: ServerContext) => ReturnType<Callback>;

/** Use update(), which also rebuilds the SDK executor that captures callbacks. */
export function enableToolProgress(tool: ProgressRegistration | undefined, enabled: boolean): void {
  if (!enabled || !tool?.handler || !tool.update) return;
  const original = tool.handler;
  const takesArguments = tool.inputSchema !== undefined;
  tool.update({
    callback: (argsOrContext: unknown, context?: ServerContext) => withToolProgress(
      takesArguments ? context : argsOrContext as ServerContext,
      enabled,
      () => takesArguments
        ? (original as Callback)(argsOrContext, context as ServerContext)
        : (original as ContextOnlyCallback)(argsOrContext as ServerContext),
    ),
  });
}
