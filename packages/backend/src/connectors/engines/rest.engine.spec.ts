import { RestEngine, serializeRepeatedParams } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';
import axios, { AxiosError } from 'axios';

// Mock the callable default export but keep the real AxiosError class so the
// engine's `instanceof AxiosError` checks (used by the retry logic) work.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: jest.fn(),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('RestEngine', () => {
  let engine: RestEngine;
  let mockOAuth2TokenService: jest.Mocked<OAuth2TokenService>;
  let mockLoginTokenService: jest.Mocked<LoginTokenService>;

  beforeEach(() => {
    mockOAuth2TokenService = {
      getAccessToken: jest.fn().mockResolvedValue('oauth2-access-token'),
      refreshToken: jest.fn().mockResolvedValue('new-access-token'),
    } as any;
    mockLoginTokenService = {
      getToken: jest.fn().mockResolvedValue({
        token: 'login-jwt',
        aud: 'test-aud',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
      forceRelogin: jest.fn().mockResolvedValue({
        token: 'login-jwt-fresh',
        aud: 'test-aud',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    } as any;
    engine = new RestEngine(mockOAuth2TokenService, mockLoginTokenService);
    jest.clearAllMocks();
  });

  it('should make a GET request with path interpolation', async () => {
    mockedAxios.mockResolvedValue({ data: { id: '123', name: 'Test' } });

    const result = await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      { method: 'GET', path: '/users/{id}' },
      { id: '123' },
    );

    expect(result).toEqual({ id: '123', name: 'Test' });
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.example.com/users/123',
      }),
    );
  });

  it('hands back only the response headers the mapping asked for, lower-cased', async () => {
    mockedAxios.mockResolvedValue({
      data: [{ id: 1 }],
      headers: {
        Link: '<https://api.example.com/items?cursor=n>; rel="next"',
        'X-RateLimit-Remaining': '9',
        'Set-Cookie': 'secret=1',
      },
    });

    const out = await engine.executeWithMeta(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      { method: 'GET', path: '/items', exposeHeaders: ['link', 'x-ratelimit-remaining'] },
      {},
    );

    expect(out.body).toEqual([{ id: 1 }]);
    expect(out.headers).toEqual({
      link: '<https://api.example.com/items?cursor=n>; rel="next"',
      'x-ratelimit-remaining': '9',
    });
  });

  it('returns no headers at all when the mapping did not opt in', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: { Link: '<u>; rel="next"' } });
    const out = await engine.executeWithMeta(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      { method: 'GET', path: '/items' },
      {},
    );
    expect(out.headers).toEqual({});
  });

  it('expands __rawquery into flat query params with dynamic keys (weclapp filter)', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/article',
        queryParams: { pageSize: '$pageSize', __rawquery: '$filter' },
      },
      {
        pageSize: 100,
        filter: 'articleNumber-eq=A5101&productionArticle-eq=true',
      },
    );

    const sent = mockedAxios.mock.calls[0][0] as unknown as { params: Record<string, unknown> };
    expect(sent.params).toEqual({
      pageSize: 100,
      'articleNumber-eq': 'A5101',
      'productionArticle-eq': 'true',
    });
    // The marker key itself must never reach the wire.
    expect(sent.params).not.toHaveProperty('__rawquery');
  });

  it('omits __rawquery entirely when the source param is absent', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/article',
        queryParams: { pageSize: '$pageSize', __rawquery: '$filter' },
      },
      { pageSize: 1 },
    );

    const sent = mockedAxios.mock.calls[0][0] as unknown as { params: Record<string, unknown> };
    expect(sent.params).toEqual({ pageSize: 1 });
    expect(sent.params).not.toHaveProperty('__rawquery');
  });

  it('signs OAUTH1 requests with an Authorization: OAuth header over the query params', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      {
        baseUrl: 'https://rest.immobilienscout24.de/restapi/api',
        authType: 'OAUTH1',
        authConfig: { consumerKey: 'CK', consumerSecret: 'CS' },
      },
      {
        method: 'GET',
        path: '/search/v1.0/search/region',
        queryParams: { geocodes: '$geocode', realestatetype: '$type' },
      },
      { geocode: '1276003001', type: 'apartmentrent' },
    );

    const sent = mockedAxios.mock.calls[0][0] as unknown as {
      headers: Record<string, string>;
      params: Record<string, unknown>;
    };
    const auth = sent.headers.Authorization;
    expect(auth).toMatch(/^OAuth /);
    expect(auth).toContain('oauth_consumer_key="CK"');
    expect(auth).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(auth).toContain('oauth_signature=');
    // Two-legged: no user token in the header.
    expect(auth).not.toContain('oauth_token=');
    // Query params still go on the wire alongside the signature.
    expect(sent.params).toEqual({
      geocodes: '1276003001',
      realestatetype: 'apartmentrent',
    });
  });

  it('should inject API key auth', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com',
        authType: 'API_KEY',
        authConfig: { headerName: 'X-Custom-Key', apiKey: 'sk-test' },
      },
      { method: 'GET', path: '/' },
      {},
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Key': 'sk-test',
        }),
      }),
    );
  });

  it('should inject bearer token auth', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com',
        authType: 'BEARER_TOKEN',
        authConfig: { token: 'my-bearer-token' },
      },
      { method: 'GET', path: '/' },
      {},
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-bearer-token',
        }),
      }),
    );
  });

  it('should inject basic auth', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com',
        authType: 'BASIC_AUTH',
        authConfig: { username: 'user', password: 'pass' },
      },
      { method: 'GET', path: '/' },
      {},
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { username: 'user', password: 'pass' },
      }),
    );
  });

  it('should map query params', async () => {
    mockedAxios.mockResolvedValue({ data: [] });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/search',
        queryParams: { q: '$query', limit: '$limit' },
      },
      { query: 'hello', limit: 10 },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { q: 'hello', limit: 10 },
      }),
    );
  });

  it('should map request body for POST', async () => {
    mockedAxios.mockResolvedValue({ data: { id: '1' } });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'POST',
        path: '/users',
        bodyMapping: { name: '$name', email: '$email' },
      },
      { name: 'John', email: 'john@test.com' },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'John', email: 'john@test.com' },
      }),
    );
  });

  it('should recursively resolve $param references in nested bodyMapping', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'POST',
        path: '/api.php',
        bodyMapping: {
          SERVICE: 'customer.get',
          LIMIT: '$LIMIT',
          FILTER: { TERM: '$TERM', COUNTRY: 'DE' },
        },
      },
      { LIMIT: 25, TERM: 'acme' },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          SERVICE: 'customer.get',
          LIMIT: 25,
          FILTER: { TERM: 'acme', COUNTRY: 'DE' },
        },
      }),
    );
  });

  it('should drop missing params from nested bodyMapping instead of sending "$TERM" literals', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'POST',
        path: '/api.php',
        bodyMapping: {
          SERVICE: 'customer.get',
          FILTER: { TERM: '$TERM' },
        },
      },
      {},
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { SERVICE: 'customer.get', FILTER: {} },
      }),
    );
  });

  it('should inject QUERY_AUTH credentials as query parameters and merge with endpoint queryParams', async () => {
    mockedAxios.mockResolvedValue({ data: {} });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com',
        authType: 'QUERY_AUTH',
        authConfig: { username: 'alice', password: 'secret' },
      },
      {
        method: 'GET',
        path: '/find',
        queryParams: { term: '$searchterm' },
      },
      { searchterm: 'hello' },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { username: 'alice', password: 'secret', term: 'hello' },
      }),
    );
  });

  it('should interpolate embedded ${param} references inside query param strings', async () => {
    mockedAxios.mockResolvedValue({ data: [] });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/ServiceRequests',
        queryParams: { $filter: "ExternalId eq '${externalId}'" },
      },
      { externalId: 'T-5432' },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { $filter: "ExternalId eq 'T-5432'" },
      }),
    );
  });

  it('should drop query param when an embedded placeholder is missing', async () => {
    mockedAxios.mockResolvedValue({ data: [] });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/ServiceRequests',
        queryParams: { $filter: "ExternalId eq '${externalId}'" },
      },
      {},
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ params: {} }),
    );
  });

  it('should drop optional query params when the value is undefined', async () => {
    mockedAxios.mockResolvedValue({ data: [] });

    await engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' },
      {
        method: 'GET',
        path: '/search',
        queryParams: { q: '$query', limit: '$limit' },
      },
      { query: 'hello' },
    );

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { q: 'hello' },
      }),
    );
  });

  describe('proxy routing', () => {
    it('wires a proxy agent and disables axios native proxy when proxyUrl is set', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        {
          baseUrl: 'https://api.example.com',
          authType: 'NONE',
          proxyUrl: 'http://user:@proxy.example.com:8011',
        },
        { method: 'GET', path: '/' },
        {},
      );

      const call = mockedAxios.mock.calls[0][0] as any;
      expect(call.proxy).toBe(false);
      expect(call.httpsAgent).toBeDefined();
      expect(call.httpAgent).toBeDefined();
    });
  });

  describe('transient-error retry', () => {
    const err = (status?: number, code?: string) =>
      new AxiosError(
        'boom',
        code,
        undefined,
        {},
        status ? ({ status, data: {} } as any) : undefined,
      );

    it('retries on 503 and returns the eventual success', async () => {
      mockedAxios
        .mockRejectedValueOnce(err(503))
        .mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/' },
        {},
      );

      expect(result).toEqual({ ok: true });
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it('retries on a connection-level error (ECONNRESET)', async () => {
      mockedAxios
        .mockRejectedValueOnce(err(undefined, 'ECONNRESET'))
        .mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/' },
        {},
      );

      expect(result).toEqual({ ok: true });
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    // A web-unblocker proxy answers 421 when its own upstream TLS handshake to
    // the origin fails, so the origin never processed the request.
    it('retries on 421 (misdirected request, e.g. proxy upstream TLS failure)', async () => {
      mockedAxios
        .mockRejectedValueOnce(err(421))
        .mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/' },
        {},
      );

      expect(result).toEqual({ ok: true });
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    // TLS alert while writing — the request never reached the application.
    it('retries on a TLS-level error (EPROTO)', async () => {
      mockedAxios
        .mockRejectedValueOnce(err(undefined, 'EPROTO'))
        .mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/' },
        {},
      );

      expect(result).toEqual({ ok: true });
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on a 400 client error', async () => {
      mockedAxios.mockRejectedValue(err(400));

      await expect(
        engine.execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        ),
      ).rejects.toBeInstanceOf(AxiosError);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('gives up after exhausting retries on persistent 503', async () => {
      mockedAxios.mockRejectedValue(err(503));

      await expect(
        engine.execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        ),
      ).rejects.toBeInstanceOf(AxiosError);
      // 1 initial + 3 retries
      expect(mockedAxios).toHaveBeenCalledTimes(4);
    });

    // Origins that reject a handshake keep rejecting for a few seconds. The
    // old two-delay budget (1.2 s) regularly gave up just short of recovery.
    it('still succeeds when the origin only recovers on the last retry', async () => {
      mockedAxios
        .mockRejectedValueOnce(err(undefined, 'EPROTO'))
        .mockRejectedValueOnce(err(undefined, 'EPROTO'))
        .mockRejectedValueOnce(err(undefined, 'EPROTO'))
        .mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/' },
        {},
      );

      expect(result).toEqual({ ok: true });
      expect(mockedAxios).toHaveBeenCalledTimes(4);
    });
  });

  /**
   * A connection-level failure used to surface to the model as the raw OpenSSL
   * dump, which reads like a credentials problem and tells nobody that trying
   * again is the right move.
   */
  describe('connection-error messages', () => {
    const err = (status?: number, code?: string) =>
      new AxiosError(
        'boom',
        code,
        undefined,
        {},
        status ? ({ status, data: {} } as any) : undefined,
      );

    it('restates a TLS handshake rejection in plain language', async () => {
      mockedAxios.mockRejectedValue(err(undefined, 'EPROTO'));

      await expect(
        engine.execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        ),
      ).rejects.toThrow(
        /Could not reach the API after 4 attempts: the TLS handshake was rejected .* \(EPROTO\)/,
      );
    });

    it('keeps the original error as `cause` and carries the code', async () => {
      const original = err(undefined, 'ECONNRESET');
      mockedAxios.mockRejectedValue(original);

      const thrown = (await engine
        .execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        )
        .catch((e: unknown) => e)) as Error & { code?: string };

      expect(thrown.cause).toBe(original);
      expect(thrown.code).toBe('ECONNRESET');
    });

    it('leaves an error that carries an HTTP status untouched', async () => {
      mockedAxios.mockRejectedValue(err(503));

      await expect(
        engine.execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        ),
      ).rejects.toBeInstanceOf(AxiosError);
    });

    it('leaves an unrecognised connection code untouched', async () => {
      mockedAxios.mockRejectedValue(err(undefined, 'ESOMETHINGELSE'));

      await expect(
        engine.execute(
          { baseUrl: 'https://api.example.com', authType: 'NONE' },
          { method: 'GET', path: '/' },
          {},
        ),
      ).rejects.toBeInstanceOf(AxiosError);
    });
  });

  describe('form body encoding (nested objects / arrays)', () => {
    it('encodes a nested object form-urlencoded param with PHP bracket notation', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://example.bitrix24.com/rest/1/token', authType: 'NONE' },
        {
          method: 'POST',
          path: '/crm.deal.add',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { fields: '$fields' },
        },
        { fields: { TITLE: 'Budget', STAGE_ID: 'NEW' } },
      );

      const sent = mockedAxios.mock.calls[0][0] as unknown as {
        data: string;
        headers: Record<string, string>;
      };
      const decoded = decodeURIComponent(sent.data);
      expect(decoded).toContain('fields[TITLE]=Budget');
      expect(decoded).toContain('fields[STAGE_ID]=NEW');
      // Regression: a nested object must never collapse to "[object Object]".
      expect(sent.data).not.toContain('object+Object');
      expect(decoded).not.toContain('[object Object]');
      expect(sent.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('keeps a Content-Type the connector configured, charset included', async () => {
      // URLSearchParams percent-encodes UTF-8, but the media type alone does
      // not say so: Destatis GENESIS decodes the body as latin-1 and answers
      // "success" with zero results unless the charset is declared.
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        {
          baseUrl: 'https://genesis.destatis.de/genesisWS/rest/2020',
          authType: 'NONE',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
        },
        {
          method: 'POST',
          path: '/find/find',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { term: '$term' },
        },
        { term: 'Bevölkerung' },
      );

      const sent = mockedAxios.mock.calls[0][0] as unknown as {
        data: string;
        headers: Record<string, string>;
      };
      expect(sent.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded; charset=UTF-8',
      );
      expect(sent.data).toContain('Bev%C3%B6lkerung');
    });

    it('matches a configured content-type case-insensitively', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        {
          baseUrl: 'https://api.example.com',
          authType: 'NONE',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        },
        {
          method: 'POST',
          path: '/x',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { a: '$a' },
        },
        { a: '1' },
      );

      const sent = mockedAxios.mock.calls[0][0] as unknown as {
        headers: Record<string, string>;
      };
      // Header names are case-insensitive, so the default must not be added
      // alongside the configured one.
      expect(sent.headers['Content-Type']).toBeUndefined();
      expect(sent.headers['content-type']).toBe(
        'application/x-www-form-urlencoded; charset=UTF-8',
      );
    });

    it('encodes an array form-urlencoded param as indexed brackets', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://example.bitrix24.com/rest/1/token', authType: 'NONE' },
        {
          method: 'POST',
          path: '/crm.deal.list',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { select: '$select' },
        },
        { select: ['ID', 'TITLE'] },
      );

      const decoded = decodeURIComponent(
        (mockedAxios.mock.calls[0][0] as unknown as { data: string }).data,
      );
      expect(decoded).toContain('select[0]=ID');
      expect(decoded).toContain('select[1]=TITLE');
    });

    it('hoists a __spread object to top-level form params (no params[] wrapper)', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://example.bitrix24.com/rest/1/token', authType: 'NONE' },
        {
          method: 'POST',
          path: '/tasks.task.add',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { __spread: '$params' },
        },
        { params: { fields: { TITLE: 'Call', RESPONSIBLE_ID: 1 } } },
      );

      const decoded = decodeURIComponent(
        (mockedAxios.mock.calls[0][0] as unknown as { data: string }).data,
      );
      // Native arg names land at the body root, NOT under params[...].
      expect(decoded).toContain('fields[TITLE]=Call');
      expect(decoded).toContain('fields[RESPONSIBLE_ID]=1');
      expect(decoded).not.toContain('params[fields]');
      expect(decoded).not.toContain('__spread');
    });

    it('hoists a scalar __spread arg (e.g. taskId) to the top level', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://example.bitrix24.com/rest/1/token', authType: 'NONE' },
        {
          method: 'POST',
          path: '/tasks.task.get',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { __spread: '$params' },
        },
        { params: { taskId: 123 } },
      );

      const decoded = decodeURIComponent(
        (mockedAxios.mock.calls[0][0] as unknown as { data: string }).data,
      );
      expect(decoded).toContain('taskId=123');
      expect(decoded).not.toContain('params[taskId]');
    });

    it('omits __spread entirely when no params object is supplied', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://example.bitrix24.com/rest/1/token', authType: 'NONE' },
        {
          method: 'POST',
          path: '/profile',
          bodyEncoding: 'form-urlencoded',
          bodyMapping: { __spread: '$params' },
        },
        {},
      );

      const sent = (mockedAxios.mock.calls[0][0] as unknown as { data: string })
        .data;
      expect(sent).not.toContain('__spread');
    });
  });

  /**
   * Both of these were found by driving shipped adapters through the engine
   * rather than by reading them: each produced a request that axios accepted
   * and the upstream rejected, with an error naming a field the adapter never
   * mentioned. The shipped adapters are used here, not paraphrases of them.
   */
  describe('array-shaped mappings keep their shape', () => {
    it('sends a top-level array bodyMapping as an array', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const bexio = require('../../adapters/ch/bexio.json') as {
        tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
      };
      const tool = bexio.tools.find((t) => t.name === 'bexio_search_contacts')!;

      await engine.execute(
        {
          baseUrl: 'https://api.bexio.com',
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'tok' },
        },
        tool.endpointMapping as never,
        { field: 'name_1', value: 'Muster', criteria: 'like' },
      );

      const body = (mockedAxios.mock.calls[0][0] as unknown as { data: unknown }).data;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual([
        { field: 'name_1', value: 'Muster', criteria: 'like' },
      ]);
    });

    it('sends OTTO price updates as the array the API documents', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const otto = require('../../adapters/de/otto-market.json') as {
        tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
      };
      const tool = otto.tools.find((t) => t.name === 'otto_market_update_price')!;

      await engine.execute(
        { baseUrl: 'https://api.otto.market', authType: 'NONE' },
        tool.endpointMapping as never,
        { sku: 'SKU-1', amount: '29.99', currency: 'EUR' },
      );

      const body = (mockedAxios.mock.calls[0][0] as unknown as { data: unknown }).data;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual([
        { sku: 'SKU-1', standardPrice: { amount: '29.99', currency: 'EUR' } },
      ]);
    });

    it('repeats an array query parameter instead of bracketing it', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const checkmk = require('../../adapters/de/checkmk.json') as {
        tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
      };
      const tool = checkmk.tools.find(
        (t) => t.name === 'checkmk_list_host_states',
      )!;

      await engine.execute(
        {
          baseUrl: 'https://cmk.test/check_mk/api/1.0',
          authType: 'API_KEY',
          authConfig: { headerName: 'Authorization', apiKey: 'Bearer u s' },
        },
        tool.endpointMapping as never,
        {},
      );

      const cfg = mockedAxios.mock.calls[0][0] as unknown as {
        params: Record<string, unknown>;
        paramsSerializer: unknown;
      };
      const query = cfg.paramsSerializer as unknown as (
        p: Record<string, unknown>,
      ) => string;
      const serialized = query(cfg.params);
      expect(serialized).toContain('columns=name&columns=state');
      expect(serialized).not.toContain('columns%5B%5D');
    });
  });

  /**
   * The serializer is applied to EVERY request that carries query params, so
   * any difference from axios's own encoding silently rewrites 254 adapters'
   * URLs. An earlier version built the string with URLSearchParams, which
   * percent-encodes the colon — that alone re-spells every ISO 8601 filter
   * value in the catalogue, and 150 adapters send one.
   *
   * So compare against real axios over a real socket rather than against a
   * hand-copied list of escape exceptions.
   */
  /**
   * The point of HMAC auth is that the secret is never sent, so the only thing
   * that can be checked is whether the digest is the one the vendor will
   * recompute. Verify against a signature computed independently here, and
   * against the shipped Kaufland adapter's own template — not against the
   * engine's own output, which would pass whatever it produced.
   */
  describe('HMAC request signing', () => {
    const crypto = jest.requireActual('node:crypto') as typeof import('node:crypto');

    it('signs the canonical string the shipped Kaufland adapter declares', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const kaufland = require('../../adapters/de/kaufland.json') as {
        connector: { authType: string; authConfig: Record<string, unknown> };
        tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
      };
      const authConfig = JSON.parse(
        JSON.stringify(kaufland.connector.authConfig)
          .replace('{{KAUFLAND_SECRET_KEY}}', 'sh-secret')
          .replace('{{KAUFLAND_CLIENT_KEY}}', 'sh-client'),
      ) as Record<string, unknown>;
      const tool = kaufland.tools.find((t) => t.name === 'kaufland_list_warehouses')!;

      const before = Math.floor(Date.now() / 1000);
      await engine.execute(
        {
          baseUrl: 'https://sellerapi.kaufland.com/v2',
          authType: 'HMAC',
          authConfig,
        },
        tool.endpointMapping as never,
        {},
      );
      const after = Math.floor(Date.now() / 1000);

      const cfg = mockedAxios.mock.calls[0][0] as unknown as {
        headers: Record<string, string>;
        url: string;
      };
      const ts = cfg.headers['Shop-Timestamp'];
      expect(Number(ts)).toBeGreaterThanOrEqual(before);
      expect(Number(ts)).toBeLessThanOrEqual(after);
      expect(cfg.headers['Shop-Client-Key']).toBe('sh-client');

      // Recompute independently, from the vendor's documented string.
      const expected = crypto
        .createHmac('sha256', 'sh-secret')
        .update(`GET\n${cfg.url}\n\n${ts}\n`, 'utf8')
        .digest('hex');
      expect(cfg.headers['Shop-Signature']).toBe(expected);
      // The secret itself must appear nowhere on the wire.
      expect(JSON.stringify(cfg)).not.toContain('sh-secret');
    });

    it('signs the body exactly as it is sent', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      const body = { sku: 'A-1', qty: 3 };
      await engine.execute(
        {
          baseUrl: 'https://api.test',
          authType: 'HMAC',
          authConfig: {
            signature: {
              secret: 's3cret',
              template: '${method}\n${path}\n${body}\n${timestamp}\n',
              headerName: 'X-Sig',
              timestampHeader: 'X-Ts',
            },
          },
        },
        { method: 'POST', path: '/units', bodyMapping: { sku: '$sku', qty: '$qty' } } as never,
        body,
      );
      const cfg = mockedAxios.mock.calls[0][0] as unknown as {
        headers: Record<string, string>;
        data: unknown;
      };
      const sent = JSON.stringify(cfg.data);
      const expected = crypto
        .createHmac('sha256', 's3cret')
        .update(`POST\n/units\n${sent}\n${cfg.headers['X-Ts']}\n`, 'utf8')
        .digest('hex');
      expect(cfg.headers['X-Sig']).toBe(expected);
    });

    it('supports base64 and sha512, and leaves other auth types alone', async () => {
      mockedAxios.mockResolvedValue({ data: {} });
      await engine.execute(
        {
          baseUrl: 'https://api.test',
          authType: 'HMAC',
          authConfig: {
            signature: {
              secret: 'k',
              algorithm: 'sha512',
              encoding: 'base64',
              template: '${method}',
              headerName: 'X-Sig',
            },
          },
        },
        { method: 'GET', path: '/x' } as never,
        {},
      );
      const cfg = mockedAxios.mock.calls[0][0] as unknown as {
        headers: Record<string, string>;
      };
      expect(cfg.headers['X-Sig']).toBe(
        crypto.createHmac('sha512', 'k').update('GET', 'utf8').digest('base64'),
      );

      mockedAxios.mockClear();
      await engine.execute(
        {
          baseUrl: 'https://api.test',
          authType: 'BEARER_TOKEN',
          authConfig: { token: 't', signature: { secret: 'k', headerName: 'X-Sig' } },
        },
        { method: 'GET', path: '/x' } as never,
        {},
      );
      const plain = mockedAxios.mock.calls[0][0] as unknown as {
        headers: Record<string, string>;
      };
      expect(plain.headers['X-Sig']).toBeUndefined();
    });
  });

  describe('serializeRepeatedParams matches axios on scalars', () => {
    const scalarCases: Array<[string, Record<string, unknown>]> = [
      ['a space', { q: 'Muster GmbH' }],
      ['an ISO timestamp', { date: '2026-09-17T00:00:00Z' }],
      ['an eBay filter', { filter: 'creationdate:[2026-09-01T00:00:00.000Z..]' }],
      ['an OData filter', { $filter: "InvoiceDate ge datetime'2026-01-01'" }],
      ['base64', { b64: 'aGVsbG8+d29ybGQ/eA==' }],
      ['reserved characters', { sym: 'a+b&c=d' }],
      ['unreserved punctuation', { punct: 'a~b', star: 'x*y', comma: 'a,b' }],
      ['non-ASCII and falsy values', { umlaut: 'Bevölkerung', zero: 0, bool: true }],
      ['a FIQL query', { query: 'status==firstLine;caller.branch.name==Berlin' }],
    ];

    let server: import('node:http').Server;
    let seen: string[] = [];
    let port = 0;

    beforeAll(async () => {
      const http = jest.requireActual('node:http') as typeof import('node:http');
      server = http.createServer((req, res) => {
        seen.push(req.url ?? '');
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it.each(scalarCases)('encodes %s the way axios does', async (_label, params) => {
      const realAxios = jest.requireActual('axios').default as (
        cfg: unknown,
      ) => Promise<unknown>;
      seen = [];
      await realAxios({
        method: 'GET',
        url: `http://127.0.0.1:${port}/x`,
        params,
      });
      expect(seen).toHaveLength(1);
      expect(`/x?${serializeRepeatedParams(params)}`).toBe(seen[0]);
    });
  });

  describe('serializeRepeatedParams', () => {
    it('repeats array members and leaves scalars alone', () => {
      expect(
        serializeRepeatedParams({ a: ['x', 'y'], b: 1, c: 'z' }),
      ).toBe('a=x&a=y&b=1&c=z');
    });

    it('drops null and undefined rather than stringifying them', () => {
      expect(
        serializeRepeatedParams({ a: undefined, b: null, c: ['k', null], d: 0 }),
      ).toBe('c=k&d=0');
    });
  });

  describe('baseUrl / path joining', () => {
    it('joins a trailing-slash baseUrl and leading-slash path with one slash', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://api.na1.insightly.com/v3.1/', authType: 'NONE' },
        { method: 'GET', path: '/Users/me' },
        {},
      );

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://api.na1.insightly.com/v3.1/Users/me',
        }),
      );
    });

    it('inserts a slash when neither baseUrl nor path provides one', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        { baseUrl: 'https://api.example.com/v1', authType: 'NONE' },
        { method: 'GET', path: 'users' },
        {},
      );

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://api.example.com/v1/users' }),
      );
    });
  });

  describe('OAuth2 token header injection', () => {
    const oauthConfig = (extra: Record<string, unknown> = {}) => ({
      baseUrl: 'https://api.example.com',
      authType: 'OAUTH2',
      authConfig: {
        clientId: 'cid',
        clientSecret: 'sec',
        refreshToken: 'rt',
        tokenUrl: 'https://auth.example.com/token',
        ...extra,
      },
    });

    it('defaults to Authorization: Bearer <token>', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(oauthConfig(), { method: 'GET', path: '/x' }, {});

      const sent = mockedAxios.mock.calls[0][0] as any;
      expect(sent.headers.Authorization).toBe('Bearer oauth2-access-token');
    });

    it('honours tokenPrefix on the Authorization header', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        oauthConfig({ tokenPrefix: 'Zoho-oauthtoken' }),
        { method: 'GET', path: '/x' },
        {},
      );

      const sent = mockedAxios.mock.calls[0][0] as any;
      expect(sent.headers.Authorization).toBe('Zoho-oauthtoken oauth2-access-token');
    });

    it('sends the raw token in a custom headerName (Amazon SP-API style)', async () => {
      mockedAxios.mockResolvedValue({ data: {} });

      await engine.execute(
        oauthConfig({ headerName: 'x-amz-access-token' }),
        { method: 'GET', path: '/orders/v0/orders' },
        {},
      );

      const sent = mockedAxios.mock.calls[0][0] as any;
      expect(sent.headers['x-amz-access-token']).toBe('oauth2-access-token');
      expect(sent.headers.Authorization).toBeUndefined();
    });

    it('re-injects the refreshed token into the custom header on 401 retry', async () => {
      const err = new AxiosError('Unauthorized');
      (err as any).response = { status: 401, data: {} };
      mockedAxios.mockRejectedValueOnce(err).mockResolvedValueOnce({ data: { ok: true } });

      const result = await engine.execute(
        oauthConfig({ headerName: 'x-amz-access-token' }),
        { method: 'GET', path: '/orders/v0/orders' },
        {},
      );

      expect(result).toEqual({ ok: true });
      const retried = mockedAxios.mock.calls[1][0] as any;
      expect(retried.headers['x-amz-access-token']).toBe('new-access-token');
      expect(retried.headers.Authorization).toBeUndefined();
    });
  });
});

describe('RestEngine — bodyTemplate that will not parse', () => {
  /**
   * A customer built a write tool on top of their Etsy connector and got
   * `bodyTemplate produced invalid JSON after interpolation: Expected property
   * name or '}' in JSON at position 38`. Position 38 of what? Not of anything
   * they can see: the rendered body is never shown, and it must not be, because
   * connector env vars are interpolated into the template before the parameters
   * are and the result can hold a credential. They debugged it by trial and
   * error and had it working eleven minutes later.
   *
   * Naming the placeholders that had nothing to substitute costs nothing and
   * points straight at the fix.
   */
  let engine: RestEngine;

  beforeEach(() => {
    engine = new RestEngine({} as any, {} as any);
  });

  const call = (bodyTemplate: string, params: Record<string, unknown>) =>
    engine.execute(
      { baseUrl: 'https://api.example.com', authType: 'NONE' } as any,
      { method: 'POST', path: '/x', bodyTemplate } as any,
      params,
    );

  it('names the placeholder nobody filled in', async () => {
    // A quoted placeholder renders as "" when absent, which is valid JSON, so
    // to break the parse the template has to reference a missing key where a
    // bare value is expected AND produce something unparseable around it.
    await expect(
      call('{"a": ${given}, "b": ${forgotten}x}', { given: 1 }),
    ).rejects.toThrow(/No value was supplied for `\$\{forgotten\}`/);
  });

  it('lists every missing placeholder, not just the first', async () => {
    await expect(
      call('{"a": ${one} ${two}x}', {}),
    ).rejects.toThrow(/`\$\{one\}`, `\$\{two\}`/);
  });

  it('says nothing extra when the template is simply malformed', async () => {
    const err: any = await call('{"a": ${given},,}', { given: 1 }).catch((e) => e);
    expect(err.message).toMatch(/produced invalid JSON after interpolation/);
    expect(err.message).not.toMatch(/No value was supplied/);
  });

  it('never repeats a rendered value, which may be a credential', async () => {
    const err: any = await call('{"t": "${token}",,}', {
      token: 'super-secret',
    }).catch((e) => e);
    expect(err.message).not.toMatch(/super-secret/);
  });
});
