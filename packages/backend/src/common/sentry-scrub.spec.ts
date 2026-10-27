import type { Event } from '@sentry/nestjs';
import { cutQueries, isMcpTransportError, scrubBreadcrumb, scrubEvent, scrubSpan, stripQuery, type StreamedSpan } from './sentry-scrub';

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

  const span = (name: string, attributes: Record<string, unknown>, is_segment = false): StreamedSpan => ({
    trace_id: 't',
    span_id: 's',
    name,
    start_timestamp: 0,
    status: 'ok',
    is_segment,
    attributes,
  });

  it('cuts queries from streamed HTTP spans and keeps only the user-agent header', () => {
    const out = scrubSpan(
      span(
        'GET /callback?code=abc&state=xyz',
        {
          'sentry.op': 'http.server',
          'url.full': 'https://cloud.example.com/callback?code=abc',
          'url.query': 'code=abc',
          'http.request.method': 'GET',
          'http.request.header.user-agent': ['claude'],
          'http.request.header.authorization': ['[Filtered]'],
          'http.request.header.cookie': ['session=s'],
          'http.response.header.set-cookie': ['a=b'],
          'http.request.body.data': '{"iban":"DE89"}',
          'client.address': '1.2.3.4',
          'user.ip_address': '1.2.3.4',
        },
        true,
      ),
    );

    expect(out.name).toBe('GET /callback');
    expect(out.attributes).toEqual({
      'sentry.op': 'http.server',
      'url.full': 'https://cloud.example.com/callback',
      'http.request.method': 'GET',
      'http.request.header.user-agent': ['claude'],
    });
  });

  it('drops MCP and GenAI content from streamed spans and keeps their metadata', () => {
    const out = scrubSpan(
      span('tools/call search_customer', {
        'sentry.op': 'mcp.server',
        'mcp.method.name': 'tools/call',
        'mcp.tool.name': 'search_customer',
        'mcp.request.argument.query': '"Rossi"',
        'mcp.tool.result.content': '[{"iban":"DE89"}]',
        'mcp.tool.result.content_count': 1,
        'gen_ai.input.messages': '[]',
        'gen_ai.output.messages': '[]',
      }),
    );

    expect(out.attributes).toEqual({
      'sentry.op': 'mcp.server',
      'mcp.method.name': 'tools/call',
      'mcp.tool.name': 'search_customer',
      'mcp.tool.result.content_count': 1,
    });
  });

  it('keeps the placeholders of database span names', () => {
    const out = scrubSpan(span('SELECT * FROM "User" WHERE id = ?', { 'sentry.op': 'db' }));
    expect(out.name).toBe('SELECT * FROM "User" WHERE id = ?');
  });

  it('handles relative and unparseable URLs', () => {
    expect(stripQuery('/authorize?client_id=a&code_challenge=b')).toBe('/authorize');
    expect(stripQuery('not a url#x')).toBe('not a url');
    expect(cutQueries('POST /token?grant_type=refresh_token')).toBe('POST /token');
  });

  it('recognises client rejections reported by the MCP integration', () => {
    const fromMcp = (errorType: string) =>
      ({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Not Acceptable: Client must accept both application/json and text/event-stream',
              mechanism: { type: 'auto.ai.mcp_server', handled: false, data: { error_type: errorType } },
            },
          ],
        },
      }) as Event;

    expect(isMcpTransportError(fromMcp('transport'))).toBe(true);
    expect(isMcpTransportError(fromMcp('tool_execution'))).toBe(false);
    expect(
      isMcpTransportError({
        exception: { values: [{ type: 'Error', mechanism: { type: 'auto.http', handled: false, data: { error_type: 'transport' } } }] },
      } as Event),
    ).toBe(false);
    expect(isMcpTransportError({ message: 'plain' } as Event)).toBe(false);
  });
});
