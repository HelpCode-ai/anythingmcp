import { RestEngine } from './rest.engine';
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
      // 1 initial + 2 retries
      expect(mockedAxios).toHaveBeenCalledTimes(3);
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
