import * as adapter from './korea-law.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string; params: Record<string, unknown> };
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams: Record<string, string> };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('korea-law adapter: static spec conformance', () => {
  it('calls the DRF endpoints with the OC user id as a query parameter', () => {
    expect(a.connector.baseUrl).toBe('https://www.law.go.kr/DRF');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ OC: '{{KOREA_LAW_OC}}' });
  });

  it('probes with a one-result law search', () => {
    expect(a.probe.tool).toBe('korea_law_search_laws');
    expect(a.probe.params).toMatchObject({ display: 1 });
  });

  it('every tool is a GET on lawSearch.do or lawService.do with a target and JSON output', () => {
    const targets = new Set<string>();
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(['/lawSearch.do', '/lawService.do']).toContain(t.endpointMapping.path);
      expect(t.endpointMapping.queryParams.type).toBe('JSON');
      targets.add(t.endpointMapping.queryParams.target);
      expect(t.name.includes('search_')).toBe(t.endpointMapping.path === '/lawSearch.do');
    }
    expect([...targets].sort()).toEqual(['admrul', 'detc', 'elaw', 'expc', 'law', 'lstrm', 'ordin', 'prec']);
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const used = new Set(Object.values(t.endpointMapping.queryParams).map((v) => v.replace(/^\$/, '')));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('uses the documented request variable names', () => {
    expect(tool('korea_law_get_law').endpointMapping.queryParams).toMatchObject({ ID: '$law_id', MST: '$mst', JO: '$article' });
    expect(tool('korea_law_search_precedents').endpointMapping.queryParams).toMatchObject({ curt: '$court', prncYd: '$decision_date_range', JO: '$referenced_law' });
    expect(tool('korea_law_get_legal_term').endpointMapping.queryParams).toMatchObject({ query: '$term' });
    expect(tool('korea_law_get_admin_rule').endpointMapping.queryParams).toMatchObject({ ID: '$rule_serial', LID: '$rule_id' });
  });
});

// Route check without credentials: the DRF endpoints answer HTTP 200 with an
// error body when OC is missing or unknown, while a made-up path is a 404.
const live = process.env.RUN_KOREA_LAW_LIVE === '1' ? describe : describe.skip;
live('korea-law adapter: live route check (no OC)', () => {
  const get = (path: string) => fetch(`${a.connector.baseUrl}${path}`);
  it('lawSearch.do and lawService.do exist and ask for the OC', async () => {
    for (const p of ['/lawSearch.do?target=law&type=JSON', '/lawService.do?target=prec&type=JSON&ID=228541']) {
      const res = await get(p);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: string };
      expect(body.result).toContain('필수입력요소');
    }
  });
  it('an unknown OC is refused with the user-verification error', async () => {
    const res = await get('/lawSearch.do?OC=amcp-route-check&target=law&type=JSON');
    expect(((await res.json()) as { result: string }).result).toContain('사용자 정보 검증');
  });
  it('a made-up path is a 404', async () => {
    expect((await get('/doesNotExist.do?target=law&type=JSON')).status).toBe(404);
  });
});
