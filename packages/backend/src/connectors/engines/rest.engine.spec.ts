import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('RestEngine', () => {
  let engine: RestEngine;
  let mockOAuth2TokenService: jest.Mocked<OAuth2TokenService>;

  beforeEach(() => {
    mockOAuth2TokenService = {
      getAccessToken: jest.fn().mockResolvedValue('oauth2-access-token'),
      refreshToken: jest.fn().mockResolvedValue('new-access-token'),
    } as any;
    engine = new RestEngine(mockOAuth2TokenService);
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
});
