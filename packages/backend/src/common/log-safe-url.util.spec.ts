import { authConfigSecrets, engineLogSecrets, urlForLog } from './log-safe-url.util';

// Shaped like a real bot token (id:35 characters) but made up.
const BOT_TOKEN = '123456789:AAHfakeTokenFor_Tests-0123456789abcd';

describe('urlForLog', () => {
  it('masks a Telegram bot token in the path without being told about it', () => {
    const line = urlForLog(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    expect(line).toBe('https://api.telegram.org/bot***/getUpdates');
    expect(line).not.toContain('AAHfake');
    expect(line).not.toContain('123456789');
  });

  it('keeps query parameter names and drops every value', () => {
    const line = urlForLog('https://api.example.com/v1/items?api_key=k3yV4lue99&token=t0kenValue77&page=2');
    expect(line).toBe('https://api.example.com/v1/items?api_key=***&token=***&page=***');
    expect(line).not.toContain('k3yV4lue99');
    expect(line).not.toContain('t0kenValue77');
  });

  it('lists the names of query parameters sent beside the URL', () => {
    const line = urlForLog('https://api.example.com/v1/items?limit=5', {
      params: { apikey: 'p4ramSecret11', q: 'shoes', empty: undefined },
    });
    expect(line).toBe('https://api.example.com/v1/items?limit=***&apikey=***&q=***');
    expect(line).not.toContain('p4ramSecret11');
  });

  it('masks a credential value it was given wherever it stands in the path', () => {
    const secret = 'plainlowercasewebhooksecret';
    const line = urlForLog(`https://hooks.example.com/services/${secret}/send`, { secrets: [secret] });
    expect(line).toBe('https://hooks.example.com/services/***/send');
  });

  it('masks a given value in its percent-encoded form too', () => {
    const secret = 'pa ss/word:with@chars';
    const line = urlForLog(
      `https://api.example.com/login/${encodeURIComponent(secret)}/x`,
      { secrets: [secret] },
    );
    expect(line).toBe('https://api.example.com/login/***/x');
  });

  it('drops userinfo and the fragment', () => {
    const line = urlForLog('https://user:hunter2pass@api.example.com/a#frag');
    expect(line).toBe('https://api.example.com/a');
  });

  it('keeps a path template readable', () => {
    expect(urlForLog('https://api.example.com/users/{id}/posts')).toBe(
      'https://api.example.com/users/{id}/posts',
    );
  });

  it('cuts an unparseable URL at its query string and still masks shapes', () => {
    const line = urlForLog(`not a url/bot${BOT_TOKEN}/x?secret=abc12345`);
    expect(line).toBe('not a url/bot***/x?secret=***');
  });

  it('never throws on odd input', () => {
    expect(urlForLog(undefined)).toBe('(no URL)');
    expect(urlForLog('')).toBe('(no URL)');
    expect(urlForLog(42)).toBe('(no URL)');
  });

  it('ignores secrets too short to mask safely', () => {
    expect(urlForLog('https://api.example.com/v1/abc', { secrets: ['abc', 'v1'] })).toBe(
      'https://api.example.com/v1/abc',
    );
  });
});

describe('authConfigSecrets / engineLogSecrets', () => {
  it('collects the credential fields and extra headers of an authConfig', () => {
    expect(
      authConfigSecrets('API_KEY', {
        headerName: 'X-API-Key',
        apiKey: 'the-api-key-1',
        extraHeaders: { 'X-PW-AccessToken': 'extra-token-1' },
      }).sort(),
    ).toEqual(['extra-token-1', 'the-api-key-1']);
  });

  it('treats every QUERY_AUTH value as a credential', () => {
    expect(authConfigSecrets('QUERY_AUTH', { appid: 'query-auth-id', appkey: 'query-auth-key' }).sort()).toEqual([
      'query-auth-id',
      'query-auth-key',
    ]);
  });

  it('adds the caller-supplied variable values', () => {
    expect(
      engineLogSecrets({ authType: 'BEARER_TOKEN', authConfig: { token: 'bearer-token-1' }, logSecrets: ['var-value-1'] }),
    ).toEqual(['var-value-1', 'bearer-token-1']);
  });
});
