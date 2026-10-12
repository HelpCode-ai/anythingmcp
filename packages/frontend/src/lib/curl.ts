/**
 * Sensitive key pattern matching credential field names across casing styles.
 * Matches: secret, password, passwd, pwd, token, jwt, assertion, credential,
 * code_verifier, code_challenge, authorization, authentication, cookie, session, bearer,
 * private_key, and key variants (api_key, access_key, privkey, ssh_key, etc.).
 */
const SENSITIVE_KEY_PATTERN =
  /secret|password|passwd|pwd|passcode|token|jwt|assertion|credential|code_verifier|code_challenge|authorization|authenticat|cookie|session|bearer|priv[-_]?key|private[-_]?key|(?:api|access|ssh|signing|encryption)[-_]?key/i;

/**
 * Checks whether an argument key name is sensitive.
 * Matches credential keywords and 'auth' variations (auth, auth_key, authHeader, clientAuth)
 * while strictly avoiding false-positives on words like 'author' or 'authority'.
 */
export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  return (
    /(?:^|[_\-])(?:auth|pin)(?:[_\-]|$)/i.test(key) ||
    /^auth[A-Z]/.test(key) ||
    /[a-z]Auth(?:[A-Z]|$)/.test(key)
  );
}

export const REDACTED_PLACEHOLDER = '[REDACTED]';
export const TRUNCATED_DEPTH_PLACEHOLDER = '[TRUNCATED:depth]';
/** Deeper than this, a whole subtree is replaced rather than walked. */
export const MAX_REDACTION_DEPTH = 10;

/**
 * Detects common sensitive credential value patterns in strings:
 * - PEM Private keys (-----BEGIN ... PRIVATE KEY-----)
 * - JWT tokens (header.payload.signature)
 * - Bearer authorization headers
 * - Common token prefixes (ghp_, gho_, xoxb-, xoxp-, sk-, AKIA, amcp_)
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9_\- ]*PRIVATE KEY-----/i,
  /^eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+$/,
  /^Bearer\s+[a-zA-Z0-9_\-\.~+/]+=*$/i,
  /^(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}|sk-(?:live-|ant-)?[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|amcp_[a-zA-Z0-9_-]{16,}|AIza[0-9A-Za-z_-]{35}|EAA[A-Za-z0-9]{60,}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|\d{6,12}:[A-Za-z0-9_-]{30,64})$/,
];

function redactSensitiveString(val: string): string {
  const trimmed = val.trim();
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return REDACTED_PLACEHOLDER;
    }
  }
  if (val.includes('://') && val.includes('@')) {
    try {
      const u = new URL(val);
      if (u.username || u.password) {
        return REDACTED_PLACEHOLDER;
      }
    } catch {
      // not a valid parseable URL, keep as is
    }
  }
  return val;
}

export interface RedactionTracker {
  redactedCount: number;
}

/**
 * Recursively redacts sensitive keys and values matching credential patterns.
 * Depth-bounded: values at or beyond MAX_REDACTION_DEPTH are truncated to prevent
 * bypass via nesting.
 */
export function redactSensitiveArgs(
  val: unknown,
  depth = 0,
  tracker?: RedactionTracker,
): unknown {
  if (val === null || val === undefined) return val;

  if (depth >= MAX_REDACTION_DEPTH) {
    if (typeof val === 'object') {
      if (tracker) tracker.redactedCount++;
      return TRUNCATED_DEPTH_PLACEHOLDER;
    }
    return val;
  }

  if (typeof val === 'string') {
    const redacted = redactSensitiveString(val);
    if (redacted !== val) {
      if (tracker) tracker.redactedCount++;
      return redacted;
    }
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => redactSensitiveArgs(item, depth + 1, tracker));
  }

  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED_PLACEHOLDER;
        if (tracker) tracker.redactedCount++;
      } else {
        out[k] = redactSensitiveArgs(v, depth + 1, tracker);
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
  authMethod?: string;
}

/**
 * Builds a cURL command to replay an MCP tool call against an AnythingMCP per-server endpoint.
 *
 * The per-server endpoint (/mcp/:serverId) runs in stateless mode by default and accepts
 * a bare `tools/call` request with MCP-Protocol-Version: 2025-06-18 directly, without
 * requiring a preceding `initialize` handshake on a local instance.
 *
 * Uses single-quoted URL with encodeURIComponent and a quoted heredoc (<<'JSON') so that
 * special characters (quotes, backticks, $, newlines) survive intact without shell injection.
 *
 * Security:
 * - Credentials are placeholder environment variables ($AMCP_MCP_API_KEY, $AMCP_ACCESS_TOKEN), never actual secrets.
 * - Sensitive keys (passwords, tokens, secrets, jwt, session, keys) and sensitive values are recursively redacted.
 * - If arguments contain redacted values or truncation markers, explicit warnings are emitted in the header comments.
 * - Dashboard session tokens (amcp_token) are never inserted.
 */
export function buildToolCallCurl({
  origin,
  serverId,
  toolName,
  args,
  authMode,
  authMethod,
}: BuildToolCallCurlOptions): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  // Single quotes stop the shell from expanding anything in the URL; the
  // encoded server id and an http(s) origin cannot contain one.
  const url = `${cleanOrigin}/mcp/${encodeURIComponent(serverId)}`.replace(/'/g, '%27');

  let authHeader: string | null = null;
  if (authMethod === 'jwt' || authMethod === 'static_bearer') {
    authHeader = '-H "Authorization: Bearer $AMCP_ACCESS_TOKEN"';
  } else if (authMethod === 'mcp_api_key' || authMethod === 'static_api_key') {
    authHeader = '-H "X-API-Key: $AMCP_MCP_API_KEY"';
  } else if (authMethod === 'none') {
    authHeader = null;
  } else if (authMode === 'oauth2') {
    authHeader = '-H "Authorization: Bearer $AMCP_ACCESS_TOKEN"';
  } else if (authMode === 'none') {
    authHeader = null;
  } else {
    authHeader = '-H "X-API-Key: $AMCP_MCP_API_KEY"';
  }

  let argumentsObj: unknown = args;
  let wasTruncated = false;

  if (typeof args === 'string') {
    try {
      argumentsObj = JSON.parse(args);
    } catch {
      argumentsObj = {};
    }
  }

  if (!argumentsObj || typeof argumentsObj !== 'object' || Array.isArray(argumentsObj)) {
    argumentsObj = {};
  } else if ('_amcp_truncated' in (argumentsObj as Record<string, unknown>)) {
    wasTruncated = true;
    const copy = { ...(argumentsObj as Record<string, unknown>) };
    delete copy._amcp_truncated;
    argumentsObj = copy;
  }

  const tracker: RedactionTracker = { redactedCount: 0 };
  const safeArguments = redactSensitiveArgs(argumentsObj, 0, tracker);

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: safeArguments,
    },
  });

  // Protect against heredoc breakout if the payload contains delimiter patterns
  let delimiter = 'JSON';
  if (
    payload.includes('\nJSON') ||
    payload.includes('\\nJSON') ||
    payload.startsWith('JSON\n') ||
    payload.startsWith('JSON\\n') ||
    payload === 'JSON'
  ) {
    delimiter = 'EOF_AMCP_JSON';
    let counter = 1;
    while (payload.includes(delimiter)) {
      delimiter = `EOF_AMCP_JSON_${counter++}`;
    }
  }

  const lines: string[] = [];
  if (tracker.redactedCount > 0) {
    lines.push(`# Some arguments were replaced with ${REDACTED_PLACEHOLDER}: fill them in before running.`);
  }
  if (wasTruncated) {
    lines.push('# WARNING: Stored input arguments were truncated in the audit log; replay may be incomplete.');
  }

  const headers = [
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept: application/json, text/event-stream" \\',
    '  -H "MCP-Protocol-Version: 2025-06-18" \\',
  ];
  if (authHeader) {
    headers.push(`  ${authHeader} \\`);
  }

  lines.push(
    `curl -sS -X POST '${url}' \\`,
    ...headers,
    `  --data-binary @- <<'${delimiter}'`,
    payload,
    delimiter,
  );

  return lines.join('\n');
}
