import * as adapter from './playtomic-public.json';

const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Array<{
    name: string;
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  }>;
};

describe('playtomic-public adapter — static spec conformance', () => {
  it('is the read-only LOGIN_TOKEN lite variant in the sports category', () => {
    expect(a.slug).toBe('playtomic-public');
    expect(a.category).toBe('sports');
    expect(a.connector.baseUrl).toBe('https://api.app.playtomic.io');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.requiredEnvVars).toEqual(['PLAYTOMIC_EMAIL', 'PLAYTOMIC_PASSWORD']);
  });

  it('logs in via /v3/auth/login and reads access_token like the full connector', () => {
    const auth = a.connector.authConfig as Record<string, unknown>;
    expect(auth.loginUrl).toBe('https://api.app.playtomic.io/v3/auth/login');
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('access_token_expiration');
    const body = auth.loginBody as Record<string, unknown>;
    expect(body.requested_user_roles).toEqual(['ROLE_CUSTOMER']);
  });

  it('exposes exactly the 4 public read tools', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual([
      'playtomic_get_availability',
      'playtomic_get_sport_configuration',
      'playtomic_get_tenant',
      'playtomic_search_tenants',
    ]);
  });

  it('search_tenants forces playtomic_status=ACTIVE and accepts geo coordinate', () => {
    const t = a.tools.find((x) => x.name === 'playtomic_search_tenants')!;
    expect(t.endpointMapping.method).toBe('GET');
    expect(t.endpointMapping.path).toBe('/v1/tenants');
    expect(t.endpointMapping.queryParams?.coordinate).toBe('$coordinate');
    expect(t.endpointMapping.queryParams?.playtomic_status).toBe('ACTIVE');
  });

  it('availability uses the documented /v1/availability path and naive ISO bounds', () => {
    const t = a.tools.find((x) => x.name === 'playtomic_get_availability')!;
    expect(t.endpointMapping.path).toBe('/v1/availability');
    expect(t.endpointMapping.queryParams?.local_start_min).toBe('$local_start_min');
    expect(t.endpointMapping.queryParams?.local_start_max).toBe('$local_start_max');
  });
});
