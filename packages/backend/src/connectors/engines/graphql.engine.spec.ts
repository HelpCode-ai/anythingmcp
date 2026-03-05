import { GraphqlEngine } from './graphql.engine';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GraphqlEngine', () => {
  let engine: GraphqlEngine;

  beforeEach(() => {
    engine = new GraphqlEngine();
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
});
