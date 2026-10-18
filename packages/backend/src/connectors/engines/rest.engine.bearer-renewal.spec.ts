import axios, { AxiosError } from 'axios';
import { RestEngine } from './rest.engine';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('RestEngine with a renewable bearer token', () => {
  const bearerTokens = {
    getToken: jest.fn(async () => 'EAAlonglived'),
    onRejected: jest.fn(async () => 'Meta ended this token session; paste a new token.'),
  };
  const engine = new RestEngine({} as any, {} as any, bearerTokens as any);
  const config = {
    baseUrl: 'https://graph.facebook.com/v25.0',
    authType: 'BEARER_TOKEN',
    authConfig: { token: 'EAApasted', tokenRenewal: { provider: 'meta' } },
    connectorId: 'conn-ig',
  };

  beforeEach(() => jest.clearAllMocks());

  it('sends the token the renewal service returns', async () => {
    mockedAxios.mockResolvedValue({ data: { id: '1' } } as any);
    await engine.execute(config, { method: 'GET', path: '/me' }, {});
    expect(bearerTokens.getToken).toHaveBeenCalledWith(config.authConfig, 'conn-ig');
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer EAAlonglived' }) }),
    );
  });

  it('hands a refused token to the service and attaches its hint to the error', async () => {
    const refusal = new AxiosError('Request failed with status code 401', undefined, undefined, {}, {
      status: 401,
      data: { error: { code: 190, error_subcode: 467, message: 'The session is invalid because the user logged out.' } },
    } as any);
    mockedAxios.mockRejectedValue(refusal);

    const err: any = await engine.execute(config, { method: 'GET', path: '/me' }, {}).catch((e) => e);
    expect(bearerTokens.onRejected).toHaveBeenCalledWith(config.authConfig, 'conn-ig', refusal);
    expect(err.hint).toBe('Meta ended this token session; paste a new token.');
    expect(err.response.status).toBe(401);
  });

  it('leaves plain bearer connectors exactly as they were', async () => {
    mockedAxios.mockResolvedValue({ data: {} } as any);
    await engine.execute({ ...config, authConfig: { token: 'plain' } }, { method: 'GET', path: '/me' }, {});
    expect(bearerTokens.getToken).not.toHaveBeenCalled();
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer plain' }) }),
    );
  });
});
