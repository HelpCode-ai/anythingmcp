import { RestEngine } from './rest.engine';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('RestEngine', () => {
  let engine: RestEngine;

  beforeEach(() => {
    engine = new RestEngine();
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
});
