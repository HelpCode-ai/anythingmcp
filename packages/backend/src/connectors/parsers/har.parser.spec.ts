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

    expect(tools).toHaveLength(2);
    expect(skipped).toEqual({ otherOrigin: 1, staticAsset: 2, duplicate: 1 });
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
    expect(orders!.endpointMapping.headers).toEqual({ 'X-Org-Id': 'org_42' });
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
    expect(login!.endpointMapping.bodyMapping).toEqual({ username: '$username', password: '$password' });
  });

  it('never lets a captured credential value survive into the parsed tools', () => {
    const { tools } = parser.parse(FIXTURE, { baseUrl: 'https://api.example.com/v2' });
    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain('deadbeef'); // Cookie
    expect(serialized).not.toContain('eyJsupersecret'); // Authorization
    expect(serialized).not.toContain('sk_live_abcdef123456'); // X-Api-Key
    expect(serialized).not.toContain('abc123'); // ?access_token=
    expect(serialized).not.toContain('hunter2'); // body password field
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
