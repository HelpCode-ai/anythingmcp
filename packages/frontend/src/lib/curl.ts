/**
 * Key pattern matching sensitive credential fields across casing styles.
 * Follows the project's established redaction model from security-event.service.
 */
const REDACTED_KEY_PATTERN =
  /secret|password|passwd|token|assertion|credential|code_verifier|code_challenge|authorization|cookie|private_key|api[-_]?key/i;

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Recursively redacts sensitive values matching credential field names.
 */
export function redactSensitiveArgs(val: unknown, depth = 0): unknown {
  if (depth > 10 || val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map((item) => redactSensitiveArgs(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (REDACTED_KEY_PATTERN.test(k)) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = redactSensitiveArgs(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

export interface BuildToolCallCurlOptions {
  origin: string;
  serverId: string;
  toolName: string;
  args?: unknown;
  authMode?: string;
}

/**
 * Builds a cURL command to replay an MCP tool call against an AnythingMCP per-server endpoint.
 *
 * The per-server endpoint (/mcp/:serverId) runs in stateless mode by default and accepts
 * a bare `tools/call` request with MCP-Protocol-Version: 2025-06-18 directly, without
 * requiring a preceding `initialize` handshake on a local instance.
 *
 * Uses a quoted heredoc (<<'JSON') so that special characters (quotes, backticks, $, newlines)
 * in tool arguments survive intact without shell escaping issues.
 *
 * Security:
 * - Credentials are always placeholder environment variables, never actual secrets.
 * - For legacy / both auth modes: X-API-Key: $AMCP_MCP_API_KEY
 * - For oauth2 auth mode: Authorization: Bearer $AMCP_ACCESS_TOKEN
 * - Dashboard session tokens (amcp_token) are never inserted.
 * - Any sensitive credential fields inside tool arguments are redacted with [REDACTED].
 */
export function buildToolCallCurl({
  origin,
  serverId,
  toolName,
  args,
  authMode,
}: BuildToolCallCurlOptions): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const url = `${cleanOrigin}/mcp/${encodeURI(serverId)}`;

  const authHeader =
    authMode === 'oauth2'
      ? '-H "Authorization: Bearer $AMCP_ACCESS_TOKEN"'
      : '-H "X-API-Key: $AMCP_MCP_API_KEY"';

  let argumentsObj: unknown = args;
  if (typeof args === 'string') {
    try {
      argumentsObj = JSON.parse(args);
    } catch {
      argumentsObj = {};
    }
  }

  if (!argumentsObj || typeof argumentsObj !== 'object' || Array.isArray(argumentsObj)) {
    argumentsObj = {};
  }

  // Redact any sensitive keys in arguments as defense-in-depth
  const safeArguments = redactSensitiveArgs(argumentsObj);

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: safeArguments,
    },
  });

  return [
    `curl -sS -X POST "${url}" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: application/json, text/event-stream" \\',
    '  -H "MCP-Protocol-Version: 2025-06-18" \\',
    `  ${authHeader} \\`,
    "  --data-binary @- <<'JSON'",
    payload,
    'JSON',
  ].join('\n');
}
