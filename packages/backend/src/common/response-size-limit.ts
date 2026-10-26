import { AxiosError } from 'axios';

/**
 * The largest upstream response body a tool call reads.
 *
 * A tool call used to load whatever the API sent. One JSON-RPC call that
 * returned about 55 MB took some 2.6 s to parse and serialize, and the event
 * loop served nothing else in that time. The connector engines (REST, which
 * also carries JSON-RPC and OData, GraphQL and SOAP) now pass this limit to
 * axios as `maxContentLength`. axios counts the decompressed bytes while it
 * reads them and stops at the limit, so an oversized body is never buffered
 * in full, parsed or sent on to the MCP client.
 *
 * `TOOL_MAX_RESPONSE_BYTES` overrides the default. It applies the same way on
 * Cloud and on self-hosted instances.
 */
export const DEFAULT_TOOL_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** The `code` of {@link ResponseTooLargeError}, as the tool result shows it. */
export const RESPONSE_TOO_LARGE_CODE = 'TOOL_RESPONSE_TOO_LARGE';

/**
 * The limit from `TOOL_MAX_RESPONSE_BYTES`: a whole number of bytes above
 * zero. Anything else (unset, empty, `10MB`, `0`) gives the default.
 */
export function toolMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOOL_MAX_RESPONSE_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TOOL_MAX_RESPONSE_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TOOL_MAX_RESPONSE_BYTES;
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${bytes} bytes`;
}

/**
 * The API sent more than the response size limit. Our own error, not the
 * API's: it has no HTTP status, and its `code` is
 * {@link RESPONSE_TOO_LARGE_CODE}. The message tells the model what to change.
 */
export class ResponseTooLargeError extends Error {
  readonly code = RESPONSE_TOO_LARGE_CODE;

  constructor(
    readonly limitBytes: number,
    options?: { cause?: unknown },
  ) {
    super(
      `The API response is larger than ${formatLimit(limitBytes)}, the limit for one tool call, ` +
        'so AnythingMCP stopped reading it and returned nothing. ' +
        'Narrow the request: add filters, ask for fewer fields, set a lower limit or page size, ' +
        'or fetch the data in smaller pages. ' +
        'An administrator can raise the limit with TOOL_MAX_RESPONSE_BYTES.',
      options,
    );
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * The error axios raises when a body passes `maxContentLength`, restated as a
 * {@link ResponseTooLargeError}. Any other error comes back unchanged.
 */
export function restateResponseTooLarge(error: unknown): unknown {
  if (!(error instanceof AxiosError) || error.response) return error;
  const match = /^maxContentLength size of (\d+) exceeded$/.exec(error.message);
  if (!match) return error;
  return new ResponseTooLargeError(Number(match[1]), { cause: error });
}
