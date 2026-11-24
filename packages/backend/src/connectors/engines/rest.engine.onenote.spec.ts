import { AxiosError, type AxiosRequestConfig } from 'axios';
import { Resvg } from '@resvg/resvg-js';
import { RestEngine } from './rest.engine';
import { outboundRequest } from '../../common/outbound-http';

jest.mock('../../common/outbound-http', () => ({
  ...jest.requireActual('../../common/outbound-http'),
  outboundRequest: jest.fn(),
}));
const request = outboundRequest as jest.MockedFunction<typeof outboundRequest>;
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>', { font: { loadSystemFonts: false } }).render().asPng();
const source = '<html><body><p>Fixture notes</p><img src="https://graph.microsoft.com/v1.0/me/onenote/resources/picture/content" width="4" height="4"/></body></html>';
const config = { baseUrl: 'https://graph.microsoft.com/v1.0', authType: 'OAUTH2', connectorId: 'connector-1', authConfig: { tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', refreshToken: 'test-refresh', accessToken: 'test-token' } };
const endpoint = { method: 'GET', path: '/me/onenote/pages/{page_id}/content', encodePathParams: true };

function reply(config: AxiosRequestConfig, data: Buffer, contentType: string) {
  const headers = { 'content-type': contentType };
  const transform = (config.transformResponse as Array<(body: unknown, headers: unknown) => unknown>)[0];
  return { data: transform(data, headers), headers, status: 200, statusText: 'OK', config } as any;
}

function setup() {
  const oauth = {
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
    renewAfterRejection: jest.fn().mockResolvedValue('renewed-token'),
    renewalFailedError: jest.fn(),
  };
  const engine = new RestEngine(oauth as any, {} as any);
  request.mockReset().mockImplementation(async (requestConfig) => requestConfig.url?.includes('/resources/')
    ? reply(requestConfig, png, 'image/png')
    : reply(requestConfig, Buffer.from(source), 'text/html; charset=utf-8'));
  return { engine, oauth };
}

describe('REST OneNote rendering', () => {
  it('requests InkML, encodes the page id and reuses the connector credentials for resources', async () => {
    const { engine, oauth } = setup();
    const result = await engine.execute(config, endpoint, { page_id: 'page/a?b' }, { render: 'onenote-page' }) as any;
    expect(result.text).toBe('Fixture notes');
    expect(result.tiles).toHaveLength(1);
    expect(request.mock.calls.map(([call]) => call.url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/onenote/pages/page%2Fa%3Fb/content',
      'https://graph.microsoft.com/v1.0/me/onenote/resources/picture/content',
    ]);
    expect(request.mock.calls[0][0].params).toMatchObject({ includeInkML: true });
    for (const [call, options] of request.mock.calls) {
      expect(call.headers).toMatchObject({ Authorization: 'Bearer test-token' });
      expect(options).toMatchObject({ maxRedirects: 0 });
    }
    expect(oauth.getAccessToken).toHaveBeenCalledWith(config.authConfig, 'connector-1');
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it('preserves the multipart boundary through response decoding', async () => {
    const { engine } = setup();
    const ink = '<ink xmlns="http://www.w3.org/2003/InkML"><trace>0 0, 2540 2540</trace></ink>';
    const body = Buffer.from(`--amcp-boundary\r\nContent-Type: text/html\r\n\r\n<html><body><p>Ink</p></body></html>\r\n--amcp-boundary\r\nContent-Type: application/inkml+xml\r\n\r\n${ink}\r\n--amcp-boundary--\r\n`);
    request.mockImplementation(async (call) => reply(call, body, 'multipart/mixed; boundary=amcp-boundary'));
    const result = await engine.execute(config, endpoint, { page_id: 'page' }, { render: 'onenote-page' }) as any;
    expect(result.tiles).toHaveLength(1);
    expect(result.width).toBeGreaterThan(96);
    expect(result.text).toBe('Ink');
  });

  it.each([
    [{ ...config, baseUrl: 'https://attacker.example/v1.0' }, endpoint],
    [config, { method: 'GET', path: '/me/drive/items/{page_id}/content' }],
    [config, { ...endpoint, method: 'POST' }],
    [config, { ...endpoint, path: '/me/onenote/pages/../content' }],
  ])('rejects a non-page endpoint before sending credentials', async (connection, mapping) => {
    const { engine } = setup();
    await expect(engine.execute(connection, mapping, { page_id: 'page' }, { render: 'onenote-page' })).rejects.toThrow('OneNote rendering requires');
    expect(request).not.toHaveBeenCalled();
  });

  it('renews OAuth on a resource 401 using the same connector id', async () => {
    const { engine, oauth } = setup();
    const credentials: string[] = [];
    let rejected = false;
    request.mockImplementation(async (call) => {
      credentials.push((call.headers as Record<string, string>).Authorization);
      if (!call.url?.includes('/resources/')) return reply(call, Buffer.from(source), 'text/html');
      if (!rejected) {
        rejected = true;
        throw new AxiosError('unauthorized', undefined, undefined, undefined, { status: 401, data: {}, headers: {} } as any);
      }
      return reply(call, png, 'image/png');
    });
    const result = await engine.execute(config, endpoint, { page_id: 'page' }, { render: 'onenote-page' }) as any;
    expect(result.tiles).toHaveLength(1);
    expect(credentials).toEqual(['Bearer test-token', 'Bearer test-token', 'Bearer renewed-token']);
    expect(oauth.renewAfterRejection).toHaveBeenCalledWith(config.authConfig, 'connector-1', expect.any(Number));
  });

  it('surfaces a refused resource instead of returning an incomplete drawing', async () => {
    const { engine } = setup();
    request.mockImplementation(async (call) => {
      if (call.url?.includes('/resources/')) throw new AxiosError('forbidden', undefined, undefined, undefined, { status: 403, data: {}, headers: {} } as any);
      return reply(call, Buffer.from(source), 'text/html');
    });
    await expect(engine.execute(config, endpoint, { page_id: 'page' }, { render: 'onenote-page' })).rejects.toMatchObject({ response: { status: 403 } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('aborts the outstanding page request when the whole call reaches its deadline', async () => {
    const { engine } = setup();
    let signal: AbortSignal | undefined;
    request.mockImplementation((call) => {
      signal = call.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new AxiosError('cancelled', 'ERR_CANCELED')), { once: true });
      });
    });
    await expect(engine.execute(config, { ...endpoint, timeoutMs: 1000 }, { page_id: 'page' }, { render: 'onenote-page' })).rejects.toThrow('rendering timed out');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a third preview before starting its page request', async () => {
    const { engine } = setup();
    const completions: Array<() => void> = [];
    request.mockImplementation((call) => new Promise<Awaited<ReturnType<typeof outboundRequest>>>((resolve) => {
      completions.push(() => resolve(reply(call, Buffer.from('<html><body><p>Notes</p></body></html>'), 'text/html')));
    }));
    const first = engine.execute(config, endpoint, { page_id: 'first' }, { render: 'onenote-page' });
    const second = engine.execute(config, endpoint, { page_id: 'second' }, { render: 'onenote-page' });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(engine.execute(config, endpoint, { page_id: 'third' }, { render: 'onenote-page' })).rejects.toThrow('busy');
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      completions.forEach((complete) => complete());
      await Promise.all([first, second]);
    }
  });
});
