import { Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { RestEngine } from './rest.engine';

// Keep the real AxiosError so the engine's retry logic recognises it.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

/**
 * The "Gave up after N attempts" warning once logged the request URL as sent,
 * and Telegram's URL carries the bot token in its path. Every line the engine
 * logs about a request must name it without a credential.
 */
describe('RestEngine log lines carry no credentials', () => {
  // Shaped like a real bot token (id:35 characters) but made up.
  const BOT_TOKEN = '123456789:AAHfakeTokenFor_Tests-0123456789abcd';
  let engine: RestEngine;
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;

  // A 429 asking for longer than a tool call can wait: the engine gives up
  // at once (no retry delay) and logs the warning.
  const rateLimited = () =>
    new AxiosError('rate limited', undefined, undefined, {}, {
      status: 429,
      data: {},
      headers: { 'retry-after': '60' },
    } as any);

  const logged = () =>
    [...warn.mock.calls, ...debug.mock.calls].map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
    engine = new RestEngine({} as any, {} as any);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    mockedAxios.mockRejectedValue(rateLimited());
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  const gaveUp = () => {
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('Gave up'));
    expect(line).toBeDefined();
    return line as string;
  };

  it('masks a Telegram bot token in the path', async () => {
    await expect(
      engine.execute(
        { baseUrl: `https://api.telegram.org/bot${BOT_TOKEN}`, authType: 'NONE' },
        { method: 'POST', path: '/getUpdates' },
        {},
      ),
    ).rejects.toBeDefined();

    expect(gaveUp()).toBe(
      'Gave up after 1 attempts on a transient upstream failure: 429 POST https://api.telegram.org/bot***/getUpdates',
    );
    expect(logged()).not.toContain('AAHfakeTokenFor_Tests');
    expect(logged()).not.toContain('123456789');
    // The request itself still went out with the token.
    expect((mockedAxios.mock.calls[0][0] as any).url).toContain(BOT_TOKEN);
  });

  it('logs query parameter names, never their values', async () => {
    await expect(
      engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        {
          method: 'GET',
          path: '/v1/search?api_key=inl1neKey42',
          queryParams: { token: '$token', q: '$q' },
        },
        { token: 'qu3ryToken77', q: 'shoes' },
      ),
    ).rejects.toBeDefined();

    expect(gaveUp()).toBe(
      'Gave up after 1 attempts on a transient upstream failure: 429 GET https://api.example.com/v1/search?api_key=***&token=***&q=***',
    );
    expect(logged()).not.toContain('inl1neKey42');
    expect(logged()).not.toContain('qu3ryToken77');
  });

  it('masks a QUERY_AUTH credential', async () => {
    await expect(
      engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'QUERY_AUTH', authConfig: { appkey: 'queryAuthSecret9' } },
        { method: 'GET', path: '/v1/items' },
        {},
      ),
    ).rejects.toBeDefined();

    expect(gaveUp()).toContain('GET https://api.example.com/v1/items?appkey=***');
    expect(logged()).not.toContain('queryAuthSecret9');
  });

  it('masks a connector credential substituted into the path, whatever its shape', async () => {
    // Lower case only: no generic rule would recognise it as a key.
    const secret = 'plainlowercasewebhooksecret';
    await expect(
      engine.execute(
        {
          baseUrl: `https://hooks.example.com/services/${secret}`,
          authType: 'NONE',
          logSecrets: [secret],
        },
        { method: 'POST', path: '/send' },
        {},
      ),
    ).rejects.toBeDefined();

    expect(gaveUp()).toContain('POST https://hooks.example.com/services/***/send');
    expect(logged()).not.toContain(secret);
  });

  it('names the endpoint by its path template, not by the values filled in', async () => {
    // An env var fills `{account_key}` by name (DynamicMcpTools.injectEnvVars).
    await expect(
      engine.execute(
        { baseUrl: 'https://api.example.com', authType: 'NONE' },
        { method: 'GET', path: '/accounts/{account_key}/orders' },
        { account_key: 'acctSecretValue1' },
      ),
    ).rejects.toBeDefined();

    expect(gaveUp()).toContain('GET https://api.example.com/accounts/{account_key}/orders');
    expect(logged()).not.toContain('acctSecretValue1');
    expect((mockedAxios.mock.calls[0][0] as any).url).toBe(
      'https://api.example.com/accounts/acctSecretValue1/orders',
    );
  });
});
