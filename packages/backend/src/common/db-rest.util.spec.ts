import { resolveInternalDbRestUrl, resolveDbRestProfile } from './db-rest.util';

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

describe('resolveDbRestProfile', () => {
  const INTERNAL = 'http://db-rest:3000';
  const cloud = { DEPLOYMENT_MODE: 'cloud', DB_REST_INTERNAL_URL: INTERNAL };
  const q = { results: '1', profile: 'dbnav' };

  it('swaps dbnav → dbweb for internal db-rest requests in cloud', () => {
    expect(
      resolveDbRestProfile(`${INTERNAL}/locations`, { ...q }, cloud as any),
    ).toEqual({ results: '1', profile: 'dbweb' });
  });

  it('tolerates a trailing slash on the internal URL', () => {
    expect(
      resolveDbRestProfile(`${INTERNAL}/journeys`, { ...q }, {
        DEPLOYMENT_MODE: 'cloud',
        DB_REST_INTERNAL_URL: `${INTERNAL}/`,
      } as any)?.profile,
    ).toBe('dbweb');
  });

  it('leaves the profile untouched on self-host (not cloud)', () => {
    expect(
      resolveDbRestProfile(`${INTERNAL}/locations`, { ...q }, {
        DB_REST_INTERNAL_URL: INTERNAL,
      } as any)?.profile,
    ).toBe('dbnav');
  });

  it('leaves the profile untouched when no internal db-rest is configured', () => {
    expect(
      resolveDbRestProfile('https://v6.db.transport.rest/locations', { ...q }, {
        DEPLOYMENT_MODE: 'cloud',
      } as any)?.profile,
    ).toBe('dbnav');
  });

  it('does not touch requests to a non-db-rest host, even in cloud', () => {
    expect(
      resolveDbRestProfile('https://api.example.com/x', { ...q }, cloud as any)?.profile,
    ).toBe('dbnav');
  });

  it('only rewrites the dbnav profile (leaves other profiles alone)', () => {
    expect(
      resolveDbRestProfile(`${INTERNAL}/locations`, { profile: 'dbris' }, cloud as any)?.profile,
    ).toBe('dbris');
  });

  it('is a no-op when there are no query params', () => {
    expect(resolveDbRestProfile(`${INTERNAL}/locations`, undefined, cloud as any)).toBeUndefined();
  });
});
