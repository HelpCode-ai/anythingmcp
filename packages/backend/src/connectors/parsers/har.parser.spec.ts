import { readFileSync } from 'fs';
import { join } from 'path';
import { HarParser } from './har.parser';

const FIXTURE = readFileSync(join(__dirname, '__fixtures__/har/sample.har.json'), 'utf-8');

describe('HarParser', () => {
  let parser: HarParser;

  beforeEach(() => {
    parser = new HarParser();
  });

  it('collapses same-template requests, skips other origins, static assets and duplicates', () => {
    const { tools, skipped } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });

    expect(tools).toHaveLength(3);
    // otherOrigin covers both a different host and /v2beta/x, which must not
    // match the /v2 prefix on a non-boundary substring match.
    expect(skipped).toEqual({ otherOrigin: 2, staticAsset: 2, duplicate: 1 });
  });

  it('does not treat /v2beta as under the /v2 base prefix', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    expect(tools.some((t) => t.endpointMapping.path.includes('beta'))).toBe(false);
  });

  it('maps a GET with a path id and query parameters', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const orders = tools.find((t) => t.endpointMapping.path === '/orders/{id}');
    expect(orders).toBeDefined();
    expect(orders!.endpointMapping.method).toBe('GET');

    const params = orders!.parameters as any;
    expect(params.properties.id).toBeDefined();
    expect(params.required).toContain('id');
    expect(params.properties.status.default).toBe('open');
    expect(orders!.endpointMapping.queryParams).toEqual({ status: '$status' });
    expect(orders!.endpointMapping.headers).toEqual({ Accept: 'application/json', 'X-Org-Id': 'org_42' });
  });

  it('respects a base URL with a path prefix', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const orders = tools.find((t) => t.endpointMapping.path === '/orders/{id}');
    // The fixture's requests are under /v2; the stored path is relative to it.
    expect(orders!.endpointMapping.path.startsWith('/v2')).toBe(false);
  });

  it('maps a JSON body, marking a credential-named field as a parameter with no default', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const login = tools.find((t) => t.endpointMapping.path === '/login');
    expect(login).toBeDefined();
    expect(login!.endpointMapping.method).toBe('POST');

    const params = login!.parameters as any;
    expect(params.properties.username.default).toBe('bob');
    expect(params.properties.password).toBeDefined();
    expect(params.properties.password.default).toBeUndefined();
  });

  it('recurses into a nested body object, dropping a nested credential but keeping its safe siblings', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const login = tools.find((t) => t.endpointMapping.path === '/login');
    const params = login!.parameters as any;

    // The nested object itself is never kept as a single opaque default —
    // it is always walked into, so `account` never reaches inferType.
    expect(params.properties.account).toBeUndefined();
    expect(params.properties.account_email.type).toBe('string');
    expect(params.properties.account_email.default).toBe('bob@example.com');
    expect(params.properties.account_password).toBeDefined();
    expect(params.properties.account_password.default).toBeUndefined();

    expect(login!.endpointMapping.bodyMapping).toEqual({
      username: '$username',
      password: '$password',
      account: { email: '$account_email', password: '$account_password' },
    });
  });

  it('sends a form body as a form, not as JSON', () => {
    const har = (postData: Record<string, unknown>) =>
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.example.com/v2/oauth/form',
                headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
                postData,
              },
            },
          ],
        },
      });

    const fromParams = parser.parse(
      har({
        mimeType: 'application/x-www-form-urlencoded; charset=UTF-8',
        params: [
          { name: 'grant_type', value: 'client_credentials' },
          { name: 'client_secret', value: 'hunter2' },
        ],
      }),
      { baseUrl: 'https://api.example.com/v2' },
    ).tools[0];
    expect(fromParams.endpointMapping.bodyEncoding).toBe('form-urlencoded');
    expect(fromParams.endpointMapping.bodyMapping).toEqual({
      grant_type: '$grant_type',
      client_secret: '$client_secret',
    });
    expect((fromParams.parameters as any).properties.client_secret.default).toBeUndefined();
    expect(JSON.stringify(fromParams)).not.toContain('hunter2');

    // Some exporters only fill in `text` for a form body.
    const fromText = parser.parse(
      har({ mimeType: 'application/x-www-form-urlencoded', text: 'q=widgets&page=2' }),
      { baseUrl: 'https://api.example.com/v2' },
    ).tools[0];
    expect(fromText.endpointMapping.bodyEncoding).toBe('form-urlencoded');
    expect(fromText.endpointMapping.bodyMapping).toEqual({ q: '$q', page: '$page' });
    expect((fromText.parameters as any).properties.page.default).toBe('2');
  });

  it('leaves the default (JSON) encoding on a JSON body', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const login = tools.find((t) => t.endpointMapping.path === '/login');
    expect(login!.endpointMapping.bodyEncoding).toBeUndefined();
  });

  it('drops credentials the issue\'s naming regex alone would miss', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const search = tools.find((t) => t.endpointMapping.path === '/search');
    expect(search).toBeDefined();

    // Ocp-Apim-Subscription-Key: a vendor header whose name has no "api-key" substring.
    // X-Custom: Bearer …: an auth-scheme value in a header name that looks like nothing special.
    // X-Firebase-AppCheck: a bare JWT in a header name with no credential word at all.
    expect(search!.endpointMapping.headers).toEqual({ Accept: 'application/json' });

    // ?key=…: a bare "key" query name, not "api_key".
    expect(search!.endpointMapping.queryParams).toEqual({ q: '$q' });
    const params = search!.parameters as any;
    expect(params.properties.key).toBeUndefined();
    expect(params.properties.q.default).toBe('widgets');
  });

  it('never lets a captured credential value survive into the parsed tools', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain('deadbeef'); // Cookie
    expect(serialized).not.toContain('eyJsupersecret'); // Authorization
    expect(serialized).not.toContain('sk_live_abcdef123456'); // X-Api-Key
    expect(serialized).not.toContain('abc123'); // ?access_token=
    expect(serialized).not.toContain('hunter2'); // body password field (top-level and nested)
    expect(serialized).not.toContain('abcdef0123456789abcdef0123456789'); // Ocp-Apim-Subscription-Key
    expect(serialized).not.toContain('abcDEF1234567890xyzLongEnough'); // X-Custom: Bearer …
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'); // X-Firebase-AppCheck JWT
    expect(serialized).not.toContain('AIzaExampleKeyValue1234567890xyz'); // ?key=
  });

  it('is deterministic: parsing the same HAR twice yields the same tool names and shapes', () => {
    const first = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const second = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    expect(second.tools).toEqual(first.tools);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => parser.parse('not json', { baseUrl: 'https://api.example.com/v2' })).toThrow();
  });

  it('rejects valid JSON that is not a HAR (no log.entries)', () => {
    expect(() => parser.parse('{"foo":"bar"}', { baseUrl: 'https://api.example.com/v2' })).toThrow();
  });
});
