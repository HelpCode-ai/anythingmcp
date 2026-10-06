/**
 * Turn a raw tool-execution failure into a coarse classification plus a
 * human-readable, actionable hint. The goal is that a trial user testing a
 * tool sees "The API key was rejected — check the key and its header" instead
 * of a bare "Request failed with status code 401". Auth hints are tailored to
 * the connector's authType so the advice points at the right field.
 */
export type ToolErrorKind =
  | 'auth_failed'
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_error'
  | 'unreachable'
  | 'error';

const AUTH_HINTS: Record<string, string> = {
  API_KEY:
    'The API key was rejected. Check the key value and that it is sent in the header this API expects.',
  BEARER_TOKEN:
    'The bearer token was rejected or has expired. Re-issue the token and update the connector.',
  OAUTH2:
    'OAuth credentials were rejected — the access token may be expired, missing a scope, or the client/secret is wrong.',
  OAUTH1: 'The OAuth 1.0a signature was rejected — check the consumer key/secret and token.',
  BASIC_AUTH:
    'The username/password (or API key used as username) was rejected. Verify both fields.',
  LOGIN_TOKEN:
    'Login failed — the email/password used to mint the session token was rejected.',
  QUERY_AUTH: 'The API key sent as a query parameter was rejected.',
  NONE: 'This API requires authentication, but the connector has no credentials configured. Set an auth type and credentials.',
};

export function classifyToolExecutionError(input: {
  status?: number;
  authType?: string | null;
  message?: string;
}): { kind: ToolErrorKind; hint: string } {
  const { status, authType, message } = input;

  if (status === 401 || status === 403) {
    const hint =
      AUTH_HINTS[String(authType ?? 'NONE')] ?? 'Credentials were rejected.';
    return { kind: 'auth_failed', hint };
  }
  if (status === 400 || status === 422) {
    return {
      kind: 'bad_request',
      hint: 'The request was rejected as invalid. Check the required parameters and their formats (the response body usually names the offending field).',
    };
  }
  // 405: something answers at this address, but not this API (a website in
  // front, or an older version without the route). Same fix as a 404.
  if (status === 404 || status === 405) {
    return {
      kind: 'not_found',
      hint: 'The endpoint was not found. Verify the tool path and the connector base URL.',
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      hint: 'The API rate-limited this request. Wait a moment and try again.',
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      kind: 'upstream_error',
      hint: `The target API returned a server error (${status}). This is on their side, not your configuration.`,
    };
  }

  // No HTTP status: network / DNS / SSRF / timeout.
  const msg = String(message ?? '');
  // JSON-RPC APIs (Odoo's /jsonrpc) answer 200 and put the refusal in the
  // body; "Access Denied" there is a wrong key, user or database, not a bug.
  if (status === undefined || status === 200) {
    if (/\bAccess ?Denied\b|AccessDenied|invalid (api )?key|authentication failed/i.test(msg)) {
      return {
        kind: 'auth_failed',
        // With credentials in the body the auth type is NONE, whose hint
        // ("no credentials configured") would be wrong here.
        hint:
          authType && authType !== 'NONE'
            ? AUTH_HINTS[authType] ?? 'Credentials were rejected.'
            : 'The API refused the credentials sent with the request. Check each of them.',
      };
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|SSRF|ECONNREFUSED|ETIMEDOUT|certificate/i.test(msg)) {
    return {
      kind: 'unreachable',
      hint: 'Could not reach the host. Check that the base URL is a full, correct address (e.g. https://api.example.com).',
    };
  }

  return {
    kind: 'error',
    hint: 'The call failed. Check the parameters and the connector configuration.',
  };
}
