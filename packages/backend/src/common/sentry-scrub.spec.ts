import type { Event } from '@sentry/nestjs';
import { cutQueries, scrubBreadcrumb, scrubEvent, stripQuery } from './sentry-scrub';

describe('sentry-scrub', () => {
  it('keeps only method, bare URL and user-agent of the request', () => {
    const event = scrubEvent({
      request: {
        method: 'POST',
        url: 'https://cloud.example.com/mcp?token=abc#frag',
        data: { method: 'tools/call', params: { arguments: { iban: 'DE89' } } },
        cookies: { session: 's' },
        query_string: 'token=abc',
        headers: { 'User-Agent': 'claude', authorization: 'Bearer x', cookie: 'a=b', 'x-forwarded-for': '1.2.3.4' },
        env: { REMOTE_ADDR: '1.2.3.4' },
      },
      user: { ip_address: '1.2.3.4', email: 'a@b.c' },
    } as Event);

    expect(event.request).toEqual({
      method: 'POST',
      url: 'https://cloud.example.com/mcp',
      headers: { 'User-Agent': 'claude' },
    });
    expect(event.user).toBeUndefined();
  });

  it('strips queries from outgoing HTTP breadcrumbs and drops console ones', () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: 'http', data: { url: 'https://api.vendor.com/v1/items?api_key=secret', 'http.query': 'api_key=secret' } },
        { category: 'console', message: 'customer row { iban: DE89 }' },
      ],
    } as Event);

    expect(event.breadcrumbs).toEqual([{ category: 'http', data: { url: 'https://api.vendor.com/v1/items' } }]);
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: '/token?code=abc' } })).toEqual({
      category: 'fetch',
      data: { url: '/token' },
    });
  });

  it('cuts queries from HTTP span names, span data and the transaction name', () => {
    const event = scrubEvent({
      type: 'transaction',
      transaction: 'GET /callback?code=abc&state=xyz',
      spans: [
        {
          op: 'http.client',
          description: 'GET https://api.vendor.com/v1?key=secret',
          data: { 'url.full': 'https://api.vendor.com/v1?key=secret', 'url.query': 'key=secret' },
        },
        { op: 'db', description: 'SELECT * FROM "User" WHERE id = $1' },
      ],
    } as unknown as Event);

    expect(event.transaction).toBe('GET /callback');
    expect(event.spans?.[0]).toMatchObject({
      description: 'GET https://api.vendor.com/v1',
      data: { 'url.full': 'https://api.vendor.com/v1' },
    });
    expect((event.spans?.[0].data as Record<string, unknown>)['url.query']).toBeUndefined();
    expect(event.spans?.[1].description).toBe('SELECT * FROM "User" WHERE id = $1');
  });

  it('handles relative and unparseable URLs', () => {
    expect(stripQuery('/authorize?client_id=a&code_challenge=b')).toBe('/authorize');
    expect(stripQuery('not a url#x')).toBe('not a url');
    expect(cutQueries('POST /token?grant_type=refresh_token')).toBe('POST /token');
  });
});
