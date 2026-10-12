import {
  SecretExtractor,
  mergeSummaries,
  toolNameFromPath,
  variablePrefix,
} from './secret-extraction.util';
import { interpolateConnectorConfig } from '../common/env-interpolation.util';
import { CurlParser } from './parsers/curl.parser';

const TG = `7123456789:${['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('')}`;
const GOOGLE = ['AI', 'zaSyB1x2y3z4A5B6C7D8E9F0gHiJkLmNoPqRs'].join('');

describe('variablePrefix', () => {
  it('turns a connector name into a variable prefix', () => {
    expect(variablePrefix('My Telegram Bot')).toBe('MY_TELEGRAM_BOT');
    expect(variablePrefix('weclappERP')).toBe('WECLAPP_ERP');
    expect(variablePrefix('123 shop')).toBe('C_123_SHOP');
    expect(variablePrefix('!!!')).toBe('CONNECTOR');
  });
});

describe('toolNameFromPath', () => {
  it('drops placeholders and path parameters', () => {
    expect(toolNameFromPath('POST', '/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage')).toBe('post_bot_sendMessage');
    expect(toolNameFromPath('GET', '/users/{id}?x=1')).toBe('get_users');
    expect(toolNameFromPath('send_message', '/mcp')).toBe('call_mcp');
  });
});

describe('SecretExtractor', () => {
  it('moves a Telegram token out of a base URL', () => {
    const x = new SecretExtractor('Telegram', {});
    const url = x.extractUrl(`https://api.telegram.org/bot${TG}`, 'baseUrl');
    expect(url).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(x.newEnvVars).toEqual({ TELEGRAM_BOT_TOKEN: TG });
    expect(x.moved).toEqual([
      expect.objectContaining({ variable: 'TELEGRAM_BOT_TOKEN', field: 'baseUrl', kind: 'telegram_bot_token' }),
    ]);
    expect(JSON.stringify(x.summary())).not.toContain(TG.split(':')[1]);
    expect(x.summary().secretsNotice).toContain('{{TELEGRAM_BOT_TOKEN}}');
  });

  it('reuses a variable that already holds the value', () => {
    const x = new SecretExtractor('Telegram', { MY_TOKEN: TG });
    expect(x.extractUrl(`/bot${TG}/getMe`, 'path')).toBe('/bot{{MY_TOKEN}}/getMe');
    expect(x.newEnvVars).toEqual({});
    expect(x.moved[0].variable).toBe('MY_TOKEN');
  });

  it('never overwrites a variable holding another value', () => {
    const x = new SecretExtractor('Telegram', { TELEGRAM_BOT_TOKEN: 'other' });
    x.extractUrl(`/bot${TG}/getMe`, 'path');
    expect(x.newEnvVars).toEqual({ TELEGRAM_BOT_TOKEN_2: TG });
  });

  it('moves a query key out of a URL', () => {
    const x = new SecretExtractor('Maps', {});
    expect(x.extractUrl('https://maps.example.com/api?key=a1b2c3d4e5f6&q=1', 'baseUrl')).toBe(
      'https://maps.example.com/api?key={{MAPS_API_KEY}}&q=1',
    );
    expect(x.newEnvVars).toEqual({ MAPS_API_KEY: 'a1b2c3d4e5f6' });
  });

  it('moves credential headers and keeps the auth scheme', () => {
    const x = new SecretExtractor('Acme CRM', {});
    const headers = x.extractHeaders(
      { Authorization: 'Bearer abcDEF123456ghi', 'X-Api-Key': 'k1k2k3k4k5', Accept: 'application/json' },
      'headers',
    );
    expect(headers).toEqual({
      Authorization: 'Bearer {{ACME_CRM_TOKEN}}',
      'X-Api-Key': '{{ACME_CRM_API_KEY}}',
      Accept: 'application/json',
    });
    expect(x.newEnvVars).toEqual({ ACME_CRM_TOKEN: 'abcDEF123456ghi', ACME_CRM_API_KEY: 'k1k2k3k4k5' });
  });

  it('only scans the headers it is told to', () => {
    const x = new SecretExtractor('Acme', {});
    const headers = x.extractHeaders(
      { Authorization: 'Bearer abcDEF123456ghi', 'X-Api-Key': 'k1k2k3k4k5' },
      'headers',
      new Set(['X-Api-Key']),
    );
    expect(headers?.Authorization).toBe('Bearer abcDEF123456ghi');
    expect(headers?.['X-Api-Key']).toBe('{{ACME_API_KEY}}');
  });

  it('rewrites a hand-written tool and regenerates a name that carried the secret', () => {
    const x = new SecretExtractor('Telegram', {});
    const tool = x.extractTool({
      name: `post_bot${TG.replace(':', '_')}_sendMessage`,
      description: `POST /bot${TG}/sendMessage`,
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage`, bodyMapping: { text: '$text' } },
    });
    expect(tool.name).toBe('post_bot_sendMessage');
    expect(tool.description).toBe('POST /bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect((tool.endpointMapping as any).path).toBe('/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect(x.renamedTools).toEqual(['post_bot_sendMessage']);
    expect(JSON.stringify({ tool, summary: x.summary() })).not.toContain(TG.split(':')[1]);
    expect(x.moved[0].field).toBe('tool post_bot_sendMessage: path');
  });

  it('keeps names that do not carry a secret, and avoids collisions', () => {
    const x = new SecretExtractor('Telegram', {}, { takenToolNames: ['post_bot_sendMessage'] });
    const kept = x.extractTool({
      name: 'send_message',
      endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage` },
    });
    expect(kept.name).toBe('send_message');
    const renamed = x.extractTool({
      name: `bot${TG.replace(':', '_')}`,
      endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage` },
    });
    expect(renamed.name).toBe('post_bot_sendMessage_2');
  });

  it('moves literal tool query parameters and headers', () => {
    const x = new SecretExtractor('Pipedrive', {});
    const tool = x.extractTool({
      name: 'list_deals',
      endpointMapping: {
        method: 'GET',
        path: '/deals',
        queryParams: { api_token: 'p1p2p3p4p5p6', limit: '$limit', q: GOOGLE },
        headers: { 'X-Auth-Token': 'h1h2h3h4h5', 'X-Version': '2' },
      },
    });
    const em = tool.endpointMapping as any;
    expect(em.queryParams).toEqual({
      api_token: '{{PIPEDRIVE_API_TOKEN}}',
      limit: '$limit',
      q: '{{PIPEDRIVE_API_KEY}}',
    });
    expect(em.headers).toEqual({ 'X-Auth-Token': '{{PIPEDRIVE_AUTH_TOKEN}}', 'X-Version': '2' });
  });

  it('takes a credential default out of the schema the AI client sees', () => {
    const x = new SecretExtractor('Weather', {});
    const tool = x.extractTool({
      name: 'get_forecast',
      parameters: {
        type: 'object',
        properties: {
          appid: { type: 'string', default: 'notasecret' },
          api_key: { type: 'string', default: 'w1w2w3w4w5w6' },
          city: { type: 'string', default: 'Berlin' },
        },
        required: ['api_key', 'city'],
      },
      endpointMapping: {
        method: 'GET',
        path: '/forecast',
        queryParams: { api_key: '$api_key', city: '$city', appid: '$appid' },
      },
    });
    const params = tool.parameters as any;
    expect(Object.keys(params.properties)).toEqual(['appid', 'city']);
    expect(params.required).toEqual(['city']);
    expect((tool.endpointMapping as any).queryParams.api_key).toBe('{{WEATHER_API_KEY}}');
    expect(x.newEnvVars).toEqual({ WEATHER_API_KEY: 'w1w2w3w4w5w6' });
  });

  it('keeps a random-looking id default (a spreadsheet) as a parameter', () => {
    const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    const x = new SecretExtractor('Sheets', {});
    const draft = {
      name: 'read_values',
      parameters: {
        type: 'object',
        properties: { spreadsheetId: { type: 'string', default: SHEET } },
      },
      endpointMapping: { method: 'GET', path: '/v4/spreadsheets/{spreadsheetId}/values/A1:B2' },
    };
    expect(x.extractTool(draft)).toEqual(draft);
    expect(x.changed).toBe(false);
  });

  it('replaces a secret used as a key as well, so the schema stays consistent', () => {
    const x = new SecretExtractor('Bot', {});
    const tool = x.extractTool({
      name: 'send',
      parameters: { type: 'object', properties: { [TG]: { type: 'string' } }, required: [TG] },
      endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage`, queryParams: { [TG]: `$${TG}` } },
    });
    const text = JSON.stringify(tool);
    expect(text).not.toContain(TG.split(':')[1]);
    const params = tool.parameters as any;
    expect(params.required).toEqual(Object.keys(params.properties));
  });

  it('leaves a clean catalog-style tool untouched', () => {
    const x = new SecretExtractor('Telegram', { TELEGRAM_BOT_TOKEN: TG });
    const tool = {
      name: 'telegram_bot_send_message',
      description: 'Send a message',
      parameters: { type: 'object', properties: { chat_id: { type: 'string' } } },
      endpointMapping: { method: 'POST', path: '/sendMessage', queryParams: { key: '{{API_KEY}}' } },
    };
    expect(x.extractTool(tool)).toEqual(tool);
    expect(x.changed).toBe(false);
    expect(x.summary()).toEqual({});
  });

  it('produces a request identical to the original once interpolated', () => {
    const x = new SecretExtractor('Telegram', {});
    const baseUrl = x.extractUrl(`https://api.telegram.org/bot${TG}`, 'baseUrl');
    const tool = x.extractTool({
      name: 'get_me',
      endpointMapping: { method: 'GET', path: '/getMe', queryParams: { key: 'a1b2c3d4e5f6' } },
    });
    const { config, endpointMapping } = interpolateConnectorConfig(
      { baseUrl },
      tool.endpointMapping as any,
      x.newEnvVars,
    );
    expect(config.baseUrl).toBe(`https://api.telegram.org/bot${TG}`);
    expect(endpointMapping.queryParams).toEqual({ key: 'a1b2c3d4e5f6' });
  });

  it('cleans a cURL import: path, name, description and query default', () => {
    const [parsed] = new CurlParser().parse(
      `curl -X POST "https://api.telegram.org/bot${TG}/sendMessage?api_key=z1z2z3z4z5z6" -d '{"chat_id":"1","text":"hi"}'`,
    );
    const x = new SecretExtractor('Telegram', {});
    const tool = x.extractTool(parsed as any);
    const serialized = JSON.stringify(tool);
    expect(serialized).not.toContain(TG.split(':')[1]);
    expect(serialized).not.toContain('z1z2z3z4z5z6');
    expect(tool.name).not.toContain('7123456789');
    expect((tool.endpointMapping as any).path).toBe('/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect((tool.endpointMapping as any).queryParams).toEqual({ api_key: '{{TELEGRAM_API_KEY}}' });
    expect(Object.keys((tool.parameters as any).properties)).not.toContain('api_key');
  });

  it('merges summaries', () => {
    const a = new SecretExtractor('A', {});
    a.extractUrl(`/bot${TG}`, 'baseUrl');
    const merged = mergeSummaries([a.summary(), {}]);
    expect(merged.secretsMoved).toHaveLength(1);
    expect(mergeSummaries([{}, {}])).toEqual({});
  });
});
