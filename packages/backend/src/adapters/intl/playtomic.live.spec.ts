import * as adapter from './playtomic.json';

const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
  };
  tools: Array<{
    name: string;
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  }>;
};

describe('playtomic adapter — static spec conformance', () => {
  it('is the full LOGIN_TOKEN variant in the sports category', () => {
    expect(a.slug).toBe('playtomic');
    expect(a.category).toBe('sports');
    expect(a.connector.baseUrl).toBe('https://app.playtomic.io');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['PLAYTOMIC_EMAIL', 'PLAYTOMIC_PASSWORD']);
  });

  it('login posts to /api/v3/auth/login with ROLE_CUSTOMER and reads access_token + expiration', () => {
    const auth = a.connector.authConfig as Record<string, unknown>;
    expect(auth.loginUrl).toBe('https://app.playtomic.io/api/v3/auth/login');
    expect(auth.loginMethod).toBe('POST');
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('access_token_expiration');
    expect(auth.expiryFormat).toBe('iso8601');
    const body = auth.loginBody as Record<string, unknown>;
    expect(body.requested_user_roles).toEqual(['ROLE_CUSTOMER']);
    expect(body.email).toBe('${username}');
    expect(body.password).toBe('${password}');
  });

  it('exposes 13 tools including personal + discovery endpoints', () => {
    expect(a.tools).toHaveLength(13);
    const names = a.tools.map((t) => t.name);
    [
      'playtomic_search_tenants',
      'playtomic_get_tenant',
      'playtomic_get_availability',
      'playtomic_get_sport_configuration',
      'playtomic_get_my_profile',
      'playtomic_get_my_level',
      'playtomic_get_my_stats',
      'playtomic_get_top_clubs',
      'playtomic_find_open_matches',
      'playtomic_get_match',
      'playtomic_match_recommendations',
      'playtomic_list_tournaments',
      'playtomic_list_leagues',
    ].forEach((n) => expect(names).toContain(n));
  });

  it('availability passes user_id=me so member pricing is applied', () => {
    const t = a.tools.find((x) => x.name === 'playtomic_get_availability')!;
    expect(t.endpointMapping.queryParams?.user_id).toBe('me');
  });

  it('personal tools (level/stats/top_clubs) use player_user_id=me — no numeric ID required', () => {
    const stats = a.tools.find((x) => x.name === 'playtomic_get_my_stats')!;
    expect(stats.endpointMapping.queryParams?.player_user_id).toBe('me');
    const top = a.tools.find((x) => x.name === 'playtomic_get_top_clubs')!;
    expect(top.endpointMapping.queryParams?.player_user_id).toBe('me');
    const level = a.tools.find((x) => x.name === 'playtomic_get_my_level')!;
    expect(level.endpointMapping.queryParams?.user_id).toBe('me');
  });
});
