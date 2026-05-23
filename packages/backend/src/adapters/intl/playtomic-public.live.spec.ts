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
  it('is the read-only NONE-auth variant in the sports category', () => {
    expect(a.slug).toBe('playtomic-public');
    expect(a.category).toBe('sports');
    expect(a.connector.baseUrl).toBe('https://app.playtomic.io');
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
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
    expect(t.endpointMapping.path).toBe('/api/v1/tenants');
    expect(t.endpointMapping.queryParams?.coordinate).toBe('$coordinate');
    expect(t.endpointMapping.queryParams?.playtomic_status).toBe('ACTIVE');
  });

  it('availability uses the documented /api/v1/availability path and naive ISO bounds', () => {
    const t = a.tools.find((x) => x.name === 'playtomic_get_availability')!;
    expect(t.endpointMapping.path).toBe('/api/v1/availability');
    expect(t.endpointMapping.queryParams?.local_start_min).toBe('$local_start_min');
    expect(t.endpointMapping.queryParams?.local_start_max).toBe('$local_start_max');
  });
});
