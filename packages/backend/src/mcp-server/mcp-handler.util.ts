import { Logger } from '@nestjs/common';
import { createMcpHandler } from '@modelcontextprotocol/server';

/** Start of the warning `createMcpHandler` prints for `responseMode: 'json'`. */
export const JSON_MODE_WARNING_PREFIX = "responseMode: 'json' drops mid-call notifications";

const logger = new Logger('McpHandler');
let jsonModeWarningLogged = false;

/**
 * `createMcpHandler`, with its `responseMode: 'json'` warning logged once per
 * process instead of once per handler.
 *
 * The SDK prints the warning with console.warn every time a handler is built
 * in JSON mode, and the endpoints build one per request: 61k plain-text lines
 * a day on cloud, a third of what pushed the docker log past its cap within
 * six hours. JSON mode is chosen on purpose there (MCP_STREAMABLE_JSON_RESPONSE,
 * for clients that cannot read SSE), so the warning says nothing new after the
 * first time.
 *
 * Only that one message is held back, and only while the handler is built:
 * `createMcpHandler` is synchronous, so console.warn is restored before any
 * other code runs, and any other warning printed meanwhile goes through.
 */
export function createQuietMcpHandler(
  ...args: Parameters<typeof createMcpHandler>
): ReturnType<typeof createMcpHandler> {
  if (args[1]?.responseMode !== 'json') return createMcpHandler(...args);
  const original = console.warn;
  console.warn = (...warnArgs: unknown[]) => {
    const first = warnArgs[0];
    if (typeof first === 'string' && first.startsWith(JSON_MODE_WARNING_PREFIX)) {
      if (!jsonModeWarningLogged) {
        jsonModeWarningLogged = true;
        logger.warn(`${first} (logged once per process)`);
      }
      return;
    }
    original.apply(console, warnArgs);
  };
  try {
    return createMcpHandler(...args);
  } finally {
    console.warn = original;
  }
}

/** Test hook: forget that the warning was logged. */
export function resetJsonModeWarningForTests(): void {
  jsonModeWarningLogged = false;
}
