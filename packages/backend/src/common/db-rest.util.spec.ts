import { resolveInternalDbRestUrl } from './db-rest.util';

describe('resolveInternalDbRestUrl', () => {
  const PUBLIC = 'https://v6.db.transport.rest';
  const cloud = { DEPLOYMENT_MODE: 'cloud', DB_REST_INTERNAL_URL: 'http://db-rest:3000' };

  it('swaps the public db-rest host for the internal one in cloud', () => {
    expect(resolveInternalDbRestUrl(PUBLIC, cloud as any)).toBe('http://db-rest:3000');
  });

  it('preserves any path and strips a trailing slash on the internal URL', () => {
    expect(
      resolveInternalDbRestUrl(`${PUBLIC}/locations`, {
        DEPLOYMENT_MODE: 'cloud',
        DB_REST_INTERNAL_URL: 'http://db-rest:3000/',
      } as any),
    ).toBe('http://db-rest:3000/locations');
  });

  it('leaves the URL untouched when not in cloud (self-host)', () => {
    expect(
      resolveInternalDbRestUrl(PUBLIC, { DB_REST_INTERNAL_URL: 'http://db-rest:3000' } as any),
    ).toBe(PUBLIC);
  });

  it('leaves the URL untouched when the internal URL is not configured', () => {
    expect(resolveInternalDbRestUrl(PUBLIC, { DEPLOYMENT_MODE: 'cloud' } as any)).toBe(PUBLIC);
  });

  it('does not touch non-db-rest base URLs', () => {
    expect(resolveInternalDbRestUrl('https://api.example.com', cloud as any)).toBe(
      'https://api.example.com',
    );
  });
});
