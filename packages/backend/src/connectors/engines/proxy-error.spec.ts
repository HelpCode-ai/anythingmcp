import { AxiosError, AxiosHeaders } from 'axios';
import { restateProxyError } from './rest.engine';

/**
 * The web-unblocker's body text is the same sentence for every failure. What
 * distinguishes "the site blocked us" from "our account is suspended" arrives
 * only in headers, and we were throwing them away — so months of deutsche-bahn
 * and etsy failures read as an unattributed "520 Server Error".
 */
describe('restateProxyError', () => {
  const err = (headers: Record<string, string>, status = 520) => {
    const e = new AxiosError('Request failed with status code ' + status);
    e.response = {
      status,
      statusText: '',
      data: 'There is a downloading problem which might be temporary.',
      headers: new AxiosHeaders(headers),
      config: { headers: new AxiosHeaders() } as never,
    };
    return e;
  };

  it('names the unblocker, the error type and the request id', () => {
    const out = restateProxyError(
      err({
        'zyte-error-type': '/download/website-ban',
        'zyte-error-title': 'Website Ban',
        'zyte-request-id': 'abc-123',
      }),
    ) as Error;
    expect(out.message).toContain('Website Ban');
    expect(out.message).toContain('/download/website-ban');
    expect(out.message).toContain('zyte-request-id abc-123');
  });

  it('says a ban is the unblocker rather than the credentials', () => {
    const out = restateProxyError(
      err({ 'zyte-error-type': '/download/website-ban' }),
    ) as Error;
    expect(out.message).toMatch(/not your credentials/);
  });

  it('keeps an unknown error type usable', () => {
    // No hint to give, but the type and the id are still what support needs.
    const out = restateProxyError(
      err({ 'zyte-error-type': '/some/new-thing', 'zyte-request-id': 'r9' }),
    ) as Error;
    expect(out.message).toContain('/some/new-thing');
    expect(out.message).toContain('r9');
  });

  it('leaves a plain HTTP error from the target untouched', () => {
    // No zyte-* headers: the API itself answered, so the original message is
    // the honest one and must not be dressed up as a proxy problem.
    const original = err({ 'content-type': 'application/json' }, 401);
    const out = restateProxyError(original) as Error;
    expect(out.message).toBe('Request failed with status code 401');
  });

  it('passes through non-Axios errors and connection failures', () => {
    const plain = new Error('boom');
    expect(restateProxyError(plain)).toBe(plain);
    const noResponse = new AxiosError('ECONNRESET');
    expect(restateProxyError(noResponse)).toBe(noResponse);
  });
});
