import { toolMaxResponseBytes } from '../../common/response-size-limit';

/**
 * Per-tool request limits of a REST tool: `endpointMapping.timeoutMs` and
 * `endpointMapping.maxResponseBytes`.
 *
 * Every REST call used to get the same 30 s timeout and the same
 * `TOOL_MAX_RESPONSE_BYTES` cap on the upstream body. Image generation does
 * not fit either: a 2K or 4K Gemini picture can take more than 30 s, and its
 * base64 in the JSON body can pass 10 MB even though `responseMapping.images`
 * takes it out of the result before anything reaches the client. Both
 * failures come after the API has run, and billed, the generation.
 *
 * A tool may therefore set its own values. They are clamped, so an adapter or
 * a user-made tool cannot switch the limits off: a timeout lies between
 * {@link MIN_TOOL_TIMEOUT_MS} and {@link MAX_TOOL_TIMEOUT_MS}, a body limit is
 * at most {@link MAX_TOOL_RESPONSE_BYTES_OVERRIDE} (or the global limit, when
 * an administrator set that higher). A missing or unreadable value keeps the
 * default. Cloud and self-hosted instances behave the same.
 */

/** The timeout of a REST tool call that sets none. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MIN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_TOOL_TIMEOUT_MS = 180_000;

/** The highest body limit a tool may ask for. */
export const MAX_TOOL_RESPONSE_BYTES_OVERRIDE = 50 * 1024 * 1024;

/**
 * A whole number above zero, given as a number or as a string of digits (a
 * mapping edited by hand may hold either). Anything else is null.
 */
function positiveInteger(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) n = Number(value.trim());
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The timeout of one call of a tool, from its `endpointMapping.timeoutMs`. */
export function toolTimeoutMs(perTool: unknown): number {
  const value = positiveInteger(perTool);
  if (value === null) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(MIN_TOOL_TIMEOUT_MS, value));
}

/**
 * The upstream body limit of one call of a tool, from its
 * `endpointMapping.maxResponseBytes`. Without one: `TOOL_MAX_RESPONSE_BYTES`.
 * A tool may set a lower limit than the global one.
 */
export function toolResponseLimitBytes(
  perTool: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const global = toolMaxResponseBytes(env);
  const value = positiveInteger(perTool);
  if (value === null) return global;
  return Math.min(value, Math.max(MAX_TOOL_RESPONSE_BYTES_OVERRIDE, global));
}
