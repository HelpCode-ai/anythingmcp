import { classifyToolExecutionError } from './connector-error.util';

describe('classifyToolExecutionError', () => {
  it('maps 401 to auth_failed with an authType-specific hint', () => {
    const r = classifyToolExecutionError({ status: 401, authType: 'API_KEY' });
    expect(r.kind).toBe('auth_failed');
    expect(r.hint).toMatch(/API key/i);
  });

  it('maps 403 to auth_failed', () => {
    expect(classifyToolExecutionError({ status: 403, authType: 'OAUTH2' }).kind).toBe(
      'auth_failed',
    );
  });

  it('gives a NONE-auth hint when the API needs credentials but none are set', () => {
    const r = classifyToolExecutionError({ status: 401, authType: 'NONE' });
    expect(r.hint).toMatch(/no credentials|no auth|requires authentication/i);
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

  it('falls back to a generic error otherwise', () => {
    expect(classifyToolExecutionError({ message: 'boom' }).kind).toBe('error');
  });

  it('reads a JSON-RPC "Access Denied" answered with 200 as auth_failed', () => {
    const out = classifyToolExecutionError({ status: 200, authType: 'NONE', message: 'Odoo error: Access Denied' });
    expect(out.kind).toBe('auth_failed');
    expect(out.hint).not.toMatch(/no credentials configured/);
    expect(classifyToolExecutionError({ message: 'odoo.exceptions.AccessDenied' }).kind).toBe('auth_failed');
  });

  it('reads a 405 like a 404: the address answers, but not as this API', () => {
    expect(classifyToolExecutionError({ status: 405 }).kind).toBe('not_found');
  });
});
