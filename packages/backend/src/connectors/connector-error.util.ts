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
  // A refused login is reported as "login request failed" and classified
  // before this table is read (see loginRequestHint); a 401/403 that reaches
  // here came from the tool call, after a login that worked.
  LOGIN_TOKEN:
    'The login worked, but the API refused the session token it returned. Check how the token is sent (headerName / headerTemplate, default "Authorization: Bearer <token>"), and that the token header does not replace a connector header with the same name that the API needs.',
  QUERY_AUTH: 'The API key sent as a query parameter was rejected.',
  // Auth type NONE also covers keys carried in the address or the body (a
  // Telegram bot token is part of the URL), so "no credentials" can be wrong.
  NONE: 'The API refused the request as unauthenticated. If the key or token is part of the address or the request (a bot token in the URL, for example), check that value; otherwise set an auth type and credentials.',
};

const PERMISSION_DENIED =
  /not permitted|not allowed|no permission|insufficient (privileges|permissions?)|not authori[sz]ed to|access to this (object|resource) is denied|-6006/i;

/**
 * The start of every error message for a failed Login → Token login request
 * (LoginTokenService), so a refused login is not mistaken for a refused tool
 * call: the tool itself was never sent.
 */
export const LOGIN_REQUEST_FAILED_PREFIX = 'LOGIN_TOKEN: login request failed';

/** Whether a message reports a failed Login → Token login request. */
export function isLoginRequestFailureMessage(message: unknown): boolean {
  return typeof message === 'string' && message.startsWith(LOGIN_REQUEST_FAILED_PREFIX);
}

/**
 * What to fix when the Login → Token login request failed, by the status the
 * login endpoint answered (undefined: no answer at all). Says plainly that
 * the tool was not called, so the advice points at the login settings and
 * not at the tool's path or parameters.
 *
 * `connectorHeaders` are the connector-level header names: they are not sent
 * with the login request, so when the login has none of them the hint says
 * where to add the ones the login needs.
 */
export function loginRequestHint(
  status: number | undefined,
  options: { connectorHeaders?: string[]; loginHeaders?: string[] } = {},
): string {
  let what: string;
  let fixable = true;
  if (status === 401 || status === 403) {
    what = `The login endpoint refused the login (HTTP ${status}): check the credentials or key the login sends, in the login body, username and password, and the headers for the login request (authConfig.loginHeaders).`;
  } else if (status === 404 || status === 405) {
    what = `The login endpoint answered HTTP ${status}: check the login URL and the login method.`;
  } else if (status === 400 || status === 415 || status === 422) {
    what = `The login endpoint rejected the request (HTTP ${status}): check the login body and its Content-Type (set another one in the headers for the login request when the endpoint expects it).`;
  } else if (status === 429) {
    what = 'The login endpoint rate-limited the login (HTTP 429). Wait a moment and try again.';
    fixable = false;
  } else if (typeof status === 'number' && status >= 500) {
    what = `The login endpoint returned a server error (HTTP ${status}). This is on the provider's side.`;
    fixable = false;
  } else if (typeof status === 'number') {
    what = `The login endpoint answered HTTP ${status}.`;
  } else {
    what = 'The login endpoint could not be reached: check the login URL.';
  }
  const sent = new Set((options.loginHeaders ?? []).map((h) => h.toLowerCase()));
  const notSent = (options.connectorHeaders ?? []).filter((h) => !sent.has(h.toLowerCase()));
  const headers = notSent.length
    ? ` Connector headers (${notSent.join(', ')}) are not sent with the login request; add any the login needs to the headers for the login request.`
    : '';
  return (
    'This is the Login → Token login request, sent before the tool call: the tool itself was not called. ' +
    what +
    headers +
    (fixable ? ' Retrying will not help until the login settings are fixed.' : '')
  );
}

/** The classification of a failed Login → Token login request. */
function classifyLoginRequestFailure(
  status: number | undefined,
  message: string,
): { kind: ToolErrorKind; hint: string } {
  const hint = loginRequestHint(status);
  if (status === 401 || status === 403) return { kind: 'auth_failed', hint };
  if (status === 404 || status === 405) return { kind: 'not_found', hint };
  if (status === 400 || status === 415 || status === 422) return { kind: 'bad_request', hint };
  if (status === 429) return { kind: 'rate_limited', hint };
  if (typeof status === 'number' && status >= 500) return { kind: 'upstream_error', hint };
  if (status === undefined && /ENOTFOUND|EAI_AGAIN|getaddrinfo|SSRF|ECONNREFUSED|ETIMEDOUT|timeout|certificate/i.test(message)) {
    return { kind: 'unreachable', hint };
  }
  return { kind: 'error', hint };
}

export function classifyToolExecutionError(input: {
  status?: number;
  authType?: string | null;
  message?: string;
}): { kind: ToolErrorKind; hint: string } {
  const { status, authType, message } = input;

  // The Login → Token login failed: the tool call was never sent, so the
  // advice is about the login settings whatever the status.
  if (isLoginRequestFailureMessage(message)) {
    return classifyLoginRequestFailure(status, String(message));
  }

  // A 403 that says the user may not do this is a missing permission, not a
  // rejected login: SAP Business One answers a write by a read-only user with
  // "Modifying this object is not permitted for current user" (-6006), and
  // "Login failed" would send the user to the wrong field.
  if (status === 403 && PERMISSION_DENIED.test(String(message ?? ''))) {
    return {
      kind: 'auth_failed',
      hint: 'The credentials work, but this user is not allowed to perform this action. Grant the permission in the target system, or keep the user read-only and use the reading tools.',
    };
  }
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
        // (about credentials in the address) would be wrong here.
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
