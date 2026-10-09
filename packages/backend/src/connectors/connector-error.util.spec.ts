import { classifyToolExecutionError } from './connector-error.util';

describe('classifyToolExecutionError', () => {
  it('maps 401 to auth_failed with an authType-specific hint', () => {
    const r = classifyToolExecutionError({ status: 401, authType: 'API_KEY' });
    expect(r.kind).toBe('auth_failed');
    expect(r.hint).toMatch(/API key/i);
  });

  it('tells a missing permission apart from a rejected login on 403', () => {
    const sap = classifyToolExecutionError({
      status: 403,
      authType: 'LOGIN_TOKEN',
      message:
        'Request failed with status code 403: body={"error":{"code":"-6006","message":"Modifying this object is not permitted for current user"}}',
    });
    expect(sap.kind).toBe('auth_failed');
    expect(sap.hint).toMatch(/not allowed to perform this action/);
    expect(sap.hint).not.toMatch(/Login failed/);
    // A plain 403 still points at the credentials.
    expect(classifyToolExecutionError({ status: 403, authType: 'LOGIN_TOKEN', message: 'Forbidden' }).hint).toMatch(/Login failed/);
    // Only 403: a 401 is a rejected credential whatever its text says.
    expect(classifyToolExecutionError({ status: 401, authType: 'LOGIN_TOKEN', message: 'not permitted' }).hint).toMatch(/Login failed/);
  });

  it('maps 403 to auth_failed', () => {
    expect(classifyToolExecutionError({ status: 403, authType: 'OAUTH2' }).kind).toBe(
      'auth_failed',
    );
  });

  it('gives a NONE-auth hint that covers both a missing auth type and a key in the address', () => {
    const r = classifyToolExecutionError({ status: 401, authType: 'NONE' });
    expect(r.hint).toMatch(/unauthenticated/);
    expect(r.hint).toMatch(/set an auth type and credentials/);
  });

  it('maps 400/422 to bad_request', () => {
    expect(classifyToolExecutionError({ status: 400 }).kind).toBe('bad_request');
    expect(classifyToolExecutionError({ status: 422 }).kind).toBe('bad_request');
  });

  it('maps 404 to not_found', () => {
    expect(classifyToolExecutionError({ status: 404 }).kind).toBe('not_found');
  });

  it('maps 429 to rate_limited', () => {
    expect(classifyToolExecutionError({ status: 429 }).kind).toBe('rate_limited');
  });

  it('maps 5xx to upstream_error', () => {
    expect(classifyToolExecutionError({ status: 503 }).kind).toBe('upstream_error');
  });

  it('maps DNS/SSRF network errors to unreachable', () => {
    const r = classifyToolExecutionError({
      message: "SSRF guard: cannot resolve 'api.https': getaddrinfo ENOTFOUND api.https",
    });
    expect(r.kind).toBe('unreachable');
    expect(r.hint).toMatch(/base URL|reach the host/i);
  });

  it('does not claim there are no credentials when the key is in the address (Telegram)', () => {
    const out = classifyToolExecutionError({ status: 401, authType: 'NONE' });
    expect(out.kind).toBe('auth_failed');
    expect(out.hint).toMatch(/part of the address/);
  });

  it('falls back to a generic error otherwise', () => {
    expect(classifyToolExecutionError({ message: 'boom' }).kind).toBe('error');
  });

  it('reads a JSON-RPC "Access Denied" answered with 200 as auth_failed', () => {
    const out = classifyToolExecutionError({ status: 200, authType: 'NONE', message: 'Odoo error: Access Denied' });
    expect(out.kind).toBe('auth_failed');
    expect(out.hint).not.toMatch(/part of the address/);
    expect(classifyToolExecutionError({ message: 'odoo.exceptions.AccessDenied' }).kind).toBe('auth_failed');
  });

  it('reads a 405 like a 404: the address answers, but not as this API', () => {
    expect(classifyToolExecutionError({ status: 405 }).kind).toBe('not_found');
  });
});
