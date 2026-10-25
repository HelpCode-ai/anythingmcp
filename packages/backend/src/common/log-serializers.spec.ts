import pino from 'pino';
import { Writable } from 'stream';
import { serializeRequest, serializeResponse } from './log-serializers';

/** What an `/mcp` request looked like in the cloud log on 21 Oct 2026, plus credentials. */
const mcpRequest = () => ({
  id: 'req-1',
  method: 'POST',
  url: '/mcp?token=one-time-secret',
  query: { token: 'one-time-secret' },
  params: { path: ['mcp'] },
  headers: {
    host: 'cloud.anythingmcp.com',
    'user-agent': 'Claude-User',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': 'tools/list',
    'mcp-protocol-version': '2026-07-28',
    via: '1.1 Caddy',
    'x-forwarded-for': '160.79.106.167, 10.0.0.1',
    authorization: 'Bearer eyJhbGciOi.secret',
    cookie: 'amcp_session=secret',
    'x-api-key': 'mcp_secret',
    'x-custom-token': 'secret',
  } as Record<string, string>,
  remoteAddress: '::ffff:172.18.0.6',
  remotePort: 32852,
});

describe('log serializers', () => {
  it('keeps what a request is looked up by, and nothing else', () => {
    expect(serializeRequest(mcpRequest())).toEqual({
      id: 'req-1',
      method: 'POST',
      url: '/mcp',
      mcpMethod: 'tools/list',
      userAgent: 'Claude-User',
      ip: '160.79.106.167',
    });
  });

  it('never writes a credential, whatever header or query parameter carries it', () => {
    expect(JSON.stringify(serializeRequest(mcpRequest()))).not.toMatch(/secret/);
  });

  it('falls back to the socket address and leaves out absent headers', () => {
    expect(
      serializeRequest({ id: 'r', method: 'GET', url: '/api/health', headers: {}, remoteAddress: '127.0.0.1' }),
    ).toEqual({ id: 'r', method: 'GET', url: '/api/health', ip: '127.0.0.1' });
  });

  it('caps a header value a client made huge', () => {
    const req = mcpRequest();
    req.headers['user-agent'] = 'x'.repeat(5_000);
    expect(serializeRequest(req).userAgent).toHaveLength(200);
  });

  it('keeps only the status of a response', () => {
    const res = { statusCode: 200, headers: { 'set-cookie': 'secret' } };
    expect(serializeResponse(res)).toEqual({ statusCode: 200 });
  });

  it('makes a request line a fraction of its former size through pino', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const withDefaults = pino({}, sink);
    const withOurs = pino({ serializers: { req: serializeRequest } }, sink);
    withDefaults.info({ req: mcpRequest() }, 'request completed');
    withOurs.info({ req: mcpRequest() }, 'request completed');
    expect(lines[0]).toMatch(/"headers"/);
    expect(lines[1]).not.toMatch(/secret|"headers"/);
    expect(lines[1].length).toBeLessThan(lines[0].length / 2);
  });
});
