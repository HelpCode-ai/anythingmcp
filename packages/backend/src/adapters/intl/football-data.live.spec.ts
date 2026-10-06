import * as adapter from './football-data.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; headers?: Record<string, string> };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('football-data adapter: static spec conformance', () => {
  it('uses API v4 with the X-Auth-Token header', () => {
    expect(a.connector.baseUrl).toBe('https://api.football-data.org/v4');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Auth-Token');
    expect(a.connector.authConfig.apiKey).toBe('{{FOOTBALL_DATA_API_TOKEN}}');
  });

  it('probes with the competition list, which needs no parameters', () => {
    expect(a.probe.tool).toBe('football_data_list_competitions');
    expect(tool('football_data_list_competitions').parameters?.required).toBeUndefined();
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values({ ...(m.queryParams ?? {}), ...(m.headers ?? {}) })) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('uses the documented camelCase filter names and unfold headers', () => {
    expect(tool('football_data_list_competition_matches').endpointMapping.queryParams).toMatchObject({ dateFrom: '$date_from', dateTo: '$date_to' });
    expect(tool('football_data_list_person_matches').endpointMapping.queryParams).toMatchObject({ e: '$event', lineup: '$lineup' });
    expect(tool('football_data_list_matches').endpointMapping.headers).toMatchObject({ 'X-Unfold-Goals': '$unfold_goals' });
    expect(tool('football_data_get_head2head').endpointMapping.path).toBe('/matches/{match_id}/head2head');
  });
});

// The area and competition lists answer without a token (100 requests a day).
const live = process.env.RUN_FOOTBALL_DATA_LIVE === '1' ? describe : describe.skip;
live('football-data adapter: live, keyless', () => {
  it('lists competitions anonymously', async () => {
    const res = await fetch(`${a.connector.baseUrl}/competitions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { competitions: Array<{ code: string }> };
    expect(body.competitions.some((c) => c.code === 'PL')).toBe(true);
  });
});
