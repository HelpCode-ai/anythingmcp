import { GraphqlEngine } from './graphql.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import axios, { AxiosError } from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GraphqlEngine', () => {
  let engine: GraphqlEngine;
  let mockOAuth2TokenService: jest.Mocked<OAuth2TokenService>;

  beforeEach(() => {
    mockOAuth2TokenService = {
      getAccessToken: jest.fn().mockResolvedValue('oauth2-access-token'),
      refreshToken: jest.fn().mockResolvedValue('new-access-token'),
    } as any;
    engine = new GraphqlEngine(mockOAuth2TokenService);
    jest.clearAllMocks();
  });

  it('should execute a basic query via axios.post', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { data: { users: [{ id: '1' }] } },
    });

    const result = await engine.execute(
      { baseUrl: 'https://api.example.com/graphql', authType: 'NONE' },
      { method: 'query', path: '{ users { id } }' },
      {},
    );

    expect(result).toEqual({ users: [{ id: '1' }] });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.example.com/graphql',
      { query: '{ users { id } }', variables: {} },
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  it('should set Content-Type: application/json header', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      { baseUrl: 'https://api.example.com/graphql', authType: 'NONE' },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('should map variables from params using queryParams mapping', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: { user: { id: '1' } } } });

    await engine.execute(
      { baseUrl: 'https://api.example.com/graphql', authType: 'NONE' },
      {
        method: 'query',
        path: 'query getUser($id: ID!) { user(id: $id) { id } }',
        queryParams: { id: '$userId' },
      },
      { userId: '42' },
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variables: { id: '42' } }),
      expect.any(Object),
    );
  });

  it('should inject BEARER_TOKEN auth into headers', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'BEARER_TOKEN',
        authConfig: { token: 'my-token' },
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-token' }),
      }),
    );
  });

  it('should inject API_KEY auth with custom header name', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'API_KEY',
        authConfig: { headerName: 'X-Custom-Key', apiKey: 'sk-test' },
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Custom-Key': 'sk-test' }),
      }),
    );
  });

  it('should inject API_KEY with default X-API-Key when no headerName', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'API_KEY',
        authConfig: { apiKey: 'sk-test' },
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'sk-test' }),
      }),
    );
  });

  it('should resolve dynamic $param headers from endpoint mapping', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      { baseUrl: 'https://api.example.com/graphql', authType: 'NONE' },
      {
        method: 'query',
        path: '{ me { id } }',
        headers: { 'X-Tenant': '$tenantId', 'X-Static': 'fixed-value' },
      },
      { tenantId: 'tenant-42' },
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Tenant': 'tenant-42',
          'X-Static': 'fixed-value',
        }),
      }),
    );
  });

  it('should throw on GraphQL errors in response', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { errors: [{ message: 'Field not found' }] },
    });

    await expect(
      engine.execute(
        { baseUrl: 'https://api.example.com/graphql', authType: 'NONE' },
        { method: 'query', path: '{ bad }' },
        {},
      ),
    ).rejects.toThrow('GraphQL errors');
  });

  it('should merge connector-level headers', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'NONE',
        headers: { 'X-Custom': 'value' },
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Custom': 'value' }),
      }),
    );
  });

  it('should inject OAUTH2 auth using OAuth2TokenService', async () => {
    mockOAuth2TokenService.getAccessToken.mockResolvedValue('my-oauth-token');
    mockedAxios.post.mockResolvedValue({ data: { data: { me: {} } } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'OAUTH2',
        authConfig: { accessToken: 'my-oauth-token' },
        connectorId: 'conn-1',
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(mockOAuth2TokenService.getAccessToken).toHaveBeenCalledWith(
      { accessToken: 'my-oauth-token' },
      'conn-1',
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-oauth-token' }),
      }),
    );
  });

  it('should inject BASIC_AUTH auth into headers', async () => {
    mockedAxios.post.mockResolvedValue({ data: { data: {} } });

    await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'BASIC_AUTH',
        authConfig: { username: 'user', password: 'pass' },
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    const expectedBasic = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expectedBasic }),
      }),
    );
  });

  it('should refresh OAuth2 token and retry on 401', async () => {
    mockOAuth2TokenService.getAccessToken.mockResolvedValue('expired-token');
    mockOAuth2TokenService.refreshToken.mockResolvedValue('fresh-token');

    // AxiosError is auto-mocked, so create instance and set properties manually
    const error401 = new AxiosError() as any;
    error401.response = { status: 401, data: {}, headers: {}, statusText: 'Unauthorized', config: {} };
    mockedAxios.post
      .mockRejectedValueOnce(error401)
      .mockResolvedValueOnce({ data: { data: { me: { id: '1' } } } });

    const result = await engine.execute(
      {
        baseUrl: 'https://api.example.com/graphql',
        authType: 'OAUTH2',
        authConfig: { accessToken: 'expired-token', refreshToken: 'rt', tokenUrl: 'https://auth/token' },
        connectorId: 'conn-1',
      },
      { method: 'query', path: '{ me { id } }' },
      {},
    );

    expect(result).toEqual({ me: { id: '1' } });
    expect(mockOAuth2TokenService.refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'rt', tokenUrl: 'https://auth/token' }),
      'conn-1',
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});
