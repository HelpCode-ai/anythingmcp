import { getAdapter } from '../adapters/catalog';
import {
  checkUserVariableNames,
  planUserVariableSwitch,
  unreferencedUserVariables,
  userVariablePlacementProblem,
} from './user-variable-switch.util';

/**
 * Switching a connector to per-user variables: afterwards nothing stored on
 * the connector may still hold the administrator's own value of a variable
 * every user enters, or it would be sent for everyone.
 */
describe('planUserVariableSwitch', () => {
  const clockodo = getAdapter('clockodo')!;
  // A catalog install as it is stored: the templates resolved once.
  const installed = () => ({
    authType: 'API_KEY',
    envVars: { CLOCKODO_API_KEY: 'admin-key-0123456789', CLOCKODO_API_USER: 'admin@example.test' },
    authConfig: {
      headerName: 'X-ClockodoApiKey',
      apiKey: 'admin-key-0123456789',
      extraHeaders: { 'X-ClockodoApiUser': 'admin@example.test' },
    } as Record<string, unknown>,
    baseUrl: 'https://my.clockodo.com/api',
    headers: { 'X-Clockodo-External-Application': 'AnythingMCP;support@anythingmcp.com' },
    config: { adapterSlug: 'clockodo' },
    toolMappings: [{ method: 'GET', path: '/v3/users' }],
    adapter: clockodo,
  });

  it('puts the fields of a catalog connector back into their {{VAR}} form and empties its own values', () => {
    const out = planUserVariableSwitch({ ...installed(), names: ['CLOCKODO_API_KEY', 'CLOCKODO_API_USER'] });
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.envVars).toEqual({ CLOCKODO_API_KEY: '', CLOCKODO_API_USER: '' });
    expect(out.plan.authConfig).toEqual({
      headerName: 'X-ClockodoApiKey',
      apiKey: '{{CLOCKODO_API_KEY}}',
      extraHeaders: { 'X-ClockodoApiUser': '{{CLOCKODO_API_USER}}' },
    });
    expect(JSON.stringify(out.plan)).not.toContain('admin-key');
    expect(JSON.stringify(out.plan)).not.toContain('admin@example.test');
  });

  it('leaves a variable that stays shared resolved as it was', () => {
    const out = planUserVariableSwitch({ ...installed(), names: ['CLOCKODO_API_KEY'] });
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.envVars).toEqual({ CLOCKODO_API_KEY: '', CLOCKODO_API_USER: 'admin@example.test' });
    expect(out.plan.authConfig).toEqual({
      headerName: 'X-ClockodoApiKey',
      apiKey: '{{CLOCKODO_API_KEY}}',
      extraHeaders: { 'X-ClockodoApiUser': 'admin@example.test' },
    });
  });

  it('removes a key a catalog field kept although its variable was emptied earlier', () => {
    const stale = installed();
    stale.envVars.CLOCKODO_API_KEY = '';
    const out = planUserVariableSwitch({ ...stale, names: ['CLOCKODO_API_KEY'] });
    if ('error' in out) throw new Error(out.error);
    expect(out.plan.authConfig?.apiKey).toBe('{{CLOCKODO_API_KEY}}');
    expect(JSON.stringify(out.plan)).not.toContain('admin-key');
  });

  const handBuilt = (authConfig: Record<string, unknown>, envVars: Record<string, string>) => ({
    authType: 'BASIC_AUTH',
    envVars,
    authConfig,
    baseUrl: 'imaps://archive.example.test:993',
    headers: null,
    config: { email: { imapHost: 'archive.example.test' } },
    toolMappings: [],
  });

  it('accepts a hand-built connector that already refers to the variables', () => {
    const out = planUserVariableSwitch({
      ...handBuilt(
        { username: '{{ARCHIVE_USERNAME}}', password: '{{ARCHIVE_PASSWORD}}' },
        { ARCHIVE_USERNAME: 'kochf\\admin', ARCHIVE_PASSWORD: 'admin-password' },
      ),
      names: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'],
    });
    expect(out).toEqual({ plan: { envVars: { ARCHIVE_USERNAME: '', ARCHIVE_PASSWORD: '' } } });
  });

  it('refuses a variable the connector uses nowhere', () => {
    const out = planUserVariableSwitch({
      ...handBuilt({ username: 'admin', password: 'admin-password' }, { ARCHIVE_PASSWORD: 'admin-password' }),
      names: ['ARCHIVE_PASSWORD'],
    });
    expect(out).toEqual({ error: expect.stringContaining('does not use {{ARCHIVE_PASSWORD}}') });
  });

  it('refuses when the old value is still stored as text next to the reference', () => {
    const out = planUserVariableSwitch({
      ...handBuilt(
        { username: '{{ARCHIVE_USERNAME}}', password: '{{ARCHIVE_PASSWORD}}', smtpPassword: 'admin-password' },
        { ARCHIVE_USERNAME: 'admin', ARCHIVE_PASSWORD: 'admin-password' },
      ),
      names: ['ARCHIVE_USERNAME', 'ARCHIVE_PASSWORD'],
    });
    expect(out).toEqual({ error: expect.stringContaining('ARCHIVE_PASSWORD is still stored in authConfig.smtpPassword') });
  });

  it('finds the old value inside a longer string too', () => {
    const out = planUserVariableSwitch({
      authType: 'NONE',
      envVars: { ACME_TOKEN: 'tok_0123456789abcdef' },
      authConfig: null,
      baseUrl: 'https://api.example.test/bot{{ACME_TOKEN}}',
      headers: { 'x-api-key': 'client-1:tok_0123456789abcdef' },
      config: null,
      toolMappings: [],
      names: ['ACME_TOKEN'],
    });
    expect(out).toEqual({ error: expect.stringContaining('still stored in headers.x-api-key') });
  });

  it('finds the old value as it reads inside a URL', () => {
    const out = planUserVariableSwitch({
      authType: 'NONE',
      envVars: { ACME_PASSWORD: 'p@ss/word+1' },
      authConfig: { password: '{{ACME_PASSWORD}}' },
      baseUrl: 'https://admin:p%40ss%2Fword%2B1@api.example.test',
      headers: null,
      config: null,
      toolMappings: [],
      names: ['ACME_PASSWORD'],
    });
    expect(out).toEqual({ error: expect.stringContaining('still stored in baseUrl') });
  });

  it('counts a variable only a tool uses as used', () => {
    const out = planUserVariableSwitch({
      authType: 'NONE',
      envVars: { ODOO_API_KEY: 'key-0123456789' },
      authConfig: null,
      baseUrl: 'https://odoo.example.test',
      headers: null,
      config: null,
      toolMappings: [{ method: 'POST', path: '/jsonrpc', bodyTemplate: '{"key":"{{ODOO_API_KEY}}"}' }],
      names: ['ODOO_API_KEY'],
    });
    expect(out).toEqual({ plan: { envVars: { ODOO_API_KEY: '' } } });
  });

  it('checks the names', () => {
    expect(checkUserVariableNames([])).toEqual({ error: expect.any(String) });
    expect(checkUserVariableNames(undefined)).toEqual({ error: expect.any(String) });
    expect(checkUserVariableNames(['amcp.user_email'])).toEqual({ error: 'Not a variable name: amcp.user_email.' });
    expect(checkUserVariableNames(['A', 'A', 'B'])).toEqual({ names: ['A', 'B'] });
    expect(checkUserVariableNames(Array.from({ length: 21 }, (_, i) => `V${i}`))).toEqual({
      error: expect.stringContaining('At most'),
    });
  });
});

describe('userVariablePlacementProblem', () => {
  const NAMES = ['ACME_TOKEN'];

  it('accepts a per-user variable in the path of the address, the headers, the sign-in and a tool', () => {
    expect(userVariablePlacementProblem(NAMES, { baseUrl: 'https://api.example.test/bot{{ACME_TOKEN}}' })).toBeNull();
    expect(userVariablePlacementProblem(NAMES, { baseUrl: '{{ACME_URL}}/v1/{{ ACME_TOKEN }}' })).toBeNull();
    expect(
      userVariablePlacementProblem(NAMES, { baseUrl: 'https://api.example.test' }, [
        { method: 'GET', path: '/users/{{ACME_TOKEN}}/orders' },
      ]),
    ).toBeNull();
    expect(
      userVariablePlacementProblem(NAMES, {
        baseUrl: 'imaps://mail.example.test:993',
        config: { email: { imapHost: 'mail.example.test', fromAddress: '{{ACME_TOKEN}}' }, mcpFixedArguments: { k: '{{ACME_TOKEN}}' } },
      }),
    ).toBeNull();
  });

  it('refuses it where it would choose the server', () => {
    for (const baseUrl of [
      'https://{{ACME_TOKEN}}.example.test/api',
      'https://api.example.test:{{ACME_TOKEN}}/api',
      'https://user:{{ACME_TOKEN}}@api.example.test/api',
      '{{ACME_TOKEN}}',
      '{{ ACME_TOKEN }}/api',
      'https://api.example.test{{ACME_TOKEN}}',
    ]) {
      expect(userVariablePlacementProblem(NAMES, { baseUrl })).toEqual(expect.stringContaining("part of the connector's address"));
    }
  });

  it('refuses it in the settings every user shares', () => {
    expect(
      userVariablePlacementProblem(NAMES, { baseUrl: 'imaps://mail.example.test', config: { email: { imapHost: '{{ACME_TOKEN}}' } } }),
    ).toEqual(expect.stringContaining('settings'));
    expect(
      userVariablePlacementProblem(NAMES, { baseUrl: 'https://mcp.example.test', config: { mcpPath: '/{{ACME_TOKEN}}' } }),
    ).toEqual(expect.stringContaining('settings'));
    // The list of names itself is not a use.
    expect(userVariablePlacementProblem(NAMES, { baseUrl: 'https://x.test', config: { userVariables: ['{{ACME_TOKEN}}'] } })).toBeNull();
  });

  it("refuses it at the start of a tool's path, where https:// would replace the address", () => {
    expect(
      userVariablePlacementProblem(NAMES, { baseUrl: 'https://api.example.test' }, [{ method: 'GET', path: ' {{ACME_TOKEN}}/orders' }]),
    ).toEqual(expect.stringContaining("path starts with {{ACME_TOKEN}}"));
  });

  it('is refused by the switch too', () => {
    const out = planUserVariableSwitch({
      authType: 'NONE',
      envVars: { ACME_TOKEN: 'shop' },
      authConfig: null,
      baseUrl: 'https://{{ACME_TOKEN}}.example.test/api',
      headers: null,
      config: null,
      toolMappings: [],
      names: NAMES,
    });
    expect(out).toEqual({ error: expect.stringContaining("part of the connector's address") });
  });
});

describe('unreferencedUserVariables', () => {
  it('reads the auth config as an object or as the JSON the registry keeps', () => {
    const connector = { baseUrl: 'https://api.example.test', authConfig: JSON.stringify({ apiKey: '{{ACME_API_KEY}}' }) };
    expect(unreferencedUserVariables(['ACME_API_KEY'], connector)).toEqual([]);
    expect(unreferencedUserVariables(['ACME_API_KEY'], { ...connector, authConfig: { apiKey: 'a-literal-key' } })).toEqual([
      'ACME_API_KEY',
    ]);
  });

  it('does not count the list of names itself as a use', () => {
    expect(
      unreferencedUserVariables(['ACME_API_KEY'], { baseUrl: 'https://x.test', config: { userVariables: ['{{ACME_API_KEY}}'] } }),
    ).toEqual(['ACME_API_KEY']);
  });
});
