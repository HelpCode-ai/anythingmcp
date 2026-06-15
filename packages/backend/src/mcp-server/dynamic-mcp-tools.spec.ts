import { DynamicMcpTools } from './dynamic-mcp-tools';
import { DeploymentService } from '../common/deployment.service';

/**
 * Focused unit test for the cloud-only db-rest host swap. Only `deployment`
 * is exercised, so the other constructor deps are passed as null.
 */
describe('DynamicMcpTools.resolveInternalBaseUrl', () => {
  const make = (isCloud: boolean) => {
    const deployment = { isCloud: () => isCloud } as unknown as DeploymentService;
    const instance = new DynamicMcpTools(
      null as any,
      null as any,
      null as any,
      null as any,
      deployment,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );
    return (url: string): string =>
      (instance as any).resolveInternalBaseUrl(url);
  };

  const PUBLIC = 'https://v6.db.transport.rest';
  const prev = process.env.DB_REST_INTERNAL_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.DB_REST_INTERNAL_URL;
    else process.env.DB_REST_INTERNAL_URL = prev;
  });

  it('swaps the public db-rest host for the internal one in cloud', () => {
    process.env.DB_REST_INTERNAL_URL = 'http://db-rest:3000';
    expect(make(true)(PUBLIC)).toBe('http://db-rest:3000');
  });

  it('strips a trailing slash on the internal URL and preserves any path', () => {
    process.env.DB_REST_INTERNAL_URL = 'http://db-rest:3000/';
    expect(make(true)(`${PUBLIC}/locations`)).toBe('http://db-rest:3000/locations');
  });

  it('leaves the URL untouched when not in cloud (self-host)', () => {
    process.env.DB_REST_INTERNAL_URL = 'http://db-rest:3000';
    expect(make(false)(PUBLIC)).toBe(PUBLIC);
  });

  it('leaves the URL untouched when the internal URL is not configured', () => {
    delete process.env.DB_REST_INTERNAL_URL;
    expect(make(true)(PUBLIC)).toBe(PUBLIC);
  });

  it('does not touch non-db-rest base URLs', () => {
    process.env.DB_REST_INTERNAL_URL = 'http://db-rest:3000';
    expect(make(true)('https://api.example.com')).toBe('https://api.example.com');
  });
});
