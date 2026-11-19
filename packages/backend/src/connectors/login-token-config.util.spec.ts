import { BadRequestException } from '@nestjs/common';
import {
  loginBodyHasLiteralSecret,
  mergeLoginTokenConfig,
  toPublicLoginTokenConfig,
} from './login-token-config.util';

/**
 * The Login → Token settings the connector editor reads and saves: secrets
 * never come back, and a save keeps every field the editor does not manage.
 */

const LITERAL = ['lit', 'eral', '-'].join('') + 'v'.repeat(10);

const stored = {
  loginUrl: 'https://api.example.com/oauth/token',
  loginMethod: 'POST',
  loginBody: { grant_type: 'client_credentials', key: '{{GARMIN_API_KEY}}' },
  loginHeaders: { 'X-Api-Key': '{{GARMIN_API_KEY}}', Authorization: `Basic ${LITERAL}`, Accept: 'text/plain' },
  username: 'user@example.com',
  password: 'secret-pass',
  tokenJsonPath: '.',
  tokenTTLSeconds: 900,
  // Not managed by the editor: must survive every save.
  headerName: 'X-Session',
  headerTemplate: '${token}',
  extraHeaders: { 'X-Client': 'amcp' },
  expiryJsonPath: 'expires_in',
};

describe('toPublicLoginTokenConfig', () => {
  it('returns the editable settings without the secrets', () => {
    const view = toPublicLoginTokenConfig(stored);
    expect(view).toMatchObject({
      loginUrl: stored.loginUrl,
      loginMethod: 'POST',
      loginBody: stored.loginBody,
      loginBodyHidden: false,
      hasUsername: true,
      hasPassword: true,
      tokenJsonPath: '',
      tokenSource: 'body',
      tokenTTLSeconds: 900,
      refreshOn401: true,
    });
    // A {{VAR}} reference is shown; a literal credential is masked.
    expect(view.loginHeaders).toEqual({ 'X-Api-Key': '{{GARMIN_API_KEY}}', Authorization: '', Accept: 'text/plain' });
    expect(view.maskedLoginHeaders).toEqual(['Authorization']);
    expect(JSON.stringify(view)).not.toContain(LITERAL);
    expect(JSON.stringify(view)).not.toContain('secret-pass');
    expect(JSON.stringify(view)).not.toContain('user@example.com');
  });

  it('hides a login body that carries a literal secret', () => {
    const view = toPublicLoginTokenConfig({ ...stored, loginBody: { apiKey: LITERAL } });
    expect(view.loginBodyHidden).toBe(true);
    expect(view.loginBody).toBeUndefined();
  });

  it('defaults an empty config sensibly', () => {
    expect(toPublicLoginTokenConfig({})).toMatchObject({
      loginUrl: '',
      loginMethod: 'POST',
      tokenJsonPath: '',
      hasUsername: false,
      hasPassword: false,
      loginHeaders: {},
      maskedLoginHeaders: [],
    });
  });
});

describe('loginBodyHasLiteralSecret', () => {
  it('tells placeholders from literal values', () => {
    expect(loginBodyHasLiteralSecret({ password: '${password}', key: '{{API_KEY}}' })).toBe(false);
    expect(loginBodyHasLiteralSecret({ grant_type: 'client_credentials' })).toBe(false);
    expect(loginBodyHasLiteralSecret({ nested: { client_secret: LITERAL } })).toBe(true);
    expect(loginBodyHasLiteralSecret(`grant_type=password&password=${LITERAL}`)).toBe(true);
    expect(loginBodyHasLiteralSecret('grant_type=password&password=${password}')).toBe(false);
  });
});

describe('mergeLoginTokenConfig', () => {
  it('keeps every field the editor does not manage', () => {
    const merged = mergeLoginTokenConfig(stored, { loginUrl: 'https://api.example.com/v2/token' });
    expect(merged).toEqual({ ...stored, loginUrl: 'https://api.example.com/v2/token' });
  });

  it('keeps a masked login header sent back empty, replaces and removes the others', () => {
    const merged = mergeLoginTokenConfig(stored, {
      loginHeaders: { 'X-Api-Key': '{{OTHER_KEY}}', Authorization: '', 'Content-Type': 'application/json' },
    });
    expect(merged.loginHeaders).toEqual({
      'X-Api-Key': '{{OTHER_KEY}}',
      Authorization: `Basic ${LITERAL}`,
      'Content-Type': 'application/json',
    });
  });

  it('stores an empty token path as the whole body (no path), and a list as given', () => {
    expect(mergeLoginTokenConfig(stored, { tokenJsonPath: '' })).not.toHaveProperty('tokenJsonPath');
    expect(mergeLoginTokenConfig(stored, { tokenJsonPath: ' token ' }).tokenJsonPath).toBe('token');
    expect(mergeLoginTokenConfig(stored, { tokenJsonPath: ['a.b', 'c'] }).tokenJsonPath).toEqual(['a.b', 'c']);
  });

  it('removes username, password, TTL and body on request, and keeps them otherwise', () => {
    const merged = mergeLoginTokenConfig(stored, { username: '', password: null, tokenTTLSeconds: null, loginBody: null });
    expect(merged).not.toHaveProperty('username');
    expect(merged).not.toHaveProperty('password');
    expect(merged).not.toHaveProperty('tokenTTLSeconds');
    expect(merged).not.toHaveProperty('loginBody');
    const kept = mergeLoginTokenConfig(stored, { refreshOn401: false });
    expect(kept.password).toBe('secret-pass');
    expect(kept.refreshOn401).toBe(false);
  });

  it('drops a raw body template when a body is typed', () => {
    const merged = mergeLoginTokenConfig({ ...stored, loginBodyTemplate: '{"a":1}' }, { loginBody: { b: 2 } });
    expect(merged.loginBody).toEqual({ b: 2 });
    expect(merged).not.toHaveProperty('loginBodyTemplate');
  });

  it('refuses values the login cannot use', () => {
    expect(() => mergeLoginTokenConfig(stored, { loginUrl: ' ' })).toThrow(BadRequestException);
    expect(() => mergeLoginTokenConfig(stored, { loginMethod: 'DELETE' })).toThrow(/GET, POST, PUT or PATCH/);
    expect(() => mergeLoginTokenConfig(stored, { tokenTTLSeconds: -5 })).toThrow(/positive number/);
    expect(() => mergeLoginTokenConfig(stored, { loginHeaders: { 'Bad Name': 'x' } })).toThrow(/not a valid HTTP header name/);
    expect(() => mergeLoginTokenConfig(stored, { loginHeaders: { 'X-A': 5 } })).toThrow(/must be a string/);
  });
});
