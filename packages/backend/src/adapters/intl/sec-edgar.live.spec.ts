import * as adapter from './sec-edgar.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * SEC EDGAR APIs (sec.gov/search-filings/edgar-application-programming-interfaces):
 * data.sec.gov submissions and XBRL APIs, efts.sec.gov full-text search and company lookup,
 * www.sec.gov/Archives filing folders. No key; SEC policy requires a User-Agent with a contact e-mail.
 * Live part: RUN_SEC_EDGAR_LIVE=1 SEC_EDGAR_USER_AGENT="Name contact@example.com" npx jest src/adapters/intl/sec-edgar
 * (reads only: a company lookup, Apple's submissions, facts, one concept, a frame, a full-text search, a filing index).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { default?: unknown; enum?: unknown[]; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: { errorWhen?: unknown[] } };
  tools: Tool[];
};
const UA = 'SEC_EDGAR_USER_AGENT';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'sec_edgar_';
const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never).value as Record<string, unknown>;

describe('sec-edgar adapter: static spec conformance', () => {
  it('needs no key but sends the contact User-Agent the SEC requires on every request', () => {
    expect(a.slug).toBe('sec-edgar');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('finance');
    expect(a.icon).toBe('sec-edgar');
    expect(a.docsUrl).toBe('https://www.sec.gov/search-filings/edgar-application-programming-interfaces');
    expect(a.requiredEnvVars).toEqual([UA]);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.connector.baseUrl).toBe('https://data.sec.gov');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.headers?.['User-Agent']).toBe(`{{${UA}}}`);
    expect(a.envVarMeta?.[UA].kind).toBe('setting');
    const pattern = new RegExp(a.envVarMeta?.[UA].pattern as string);
    expect(pattern.test(['Example Research LLC', ['admin', 'example.com'].join('@')].join(' '))).toBe(true);
    expect(pattern.test('AnythingMCP')).toBe(false);
    expect(pattern.test(['admin', 'example.com'].join('@'))).toBe(false);
    // A blank full-text search answers 200 with an "error" text: it must fail the call.
    expect(a.connector.config?.errorWhen).toEqual([{ path: 'error', matches: '.', messagePath: 'error', status: 400 }]);
  });

  it('maps the documented data.sec.gov, efts and archive routes', () => {
    const routes: Record<string, string> = {
      sec_edgar_search_companies: EFTS,
      sec_edgar_get_submissions: '/submissions/CIK{cik}.json',
      sec_edgar_get_older_filings: '/submissions/{file_name}',
      sec_edgar_get_company_facts: '/api/xbrl/companyfacts/CIK{cik}.json',
      sec_edgar_get_company_concept: '/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{tag}.json',
      sec_edgar_get_frames: '/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json',
      sec_edgar_full_text_search: EFTS,
      sec_edgar_get_filing_index: 'https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/index.json',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(routes).sort());
    for (const [name, path] of Object.entries(routes)) expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path });
    expect(tool('sec_edgar_search_companies').endpointMapping.queryParams).toEqual({ keysTyped: '$keysTyped' });
    expect(tool('sec_edgar_full_text_search').endpointMapping.queryParams).toEqual({
      q: '$q', forms: '$forms', startdt: '$startdt', enddt: '$enddt', ciks: '$ciks', entityName: '$entityName', locationCodes: '$locationCodes', from: '$from',
    });
  });

  it('validates CIKs, periods and file names in the shapes the SEC uses', () => {
    const cik = new RegExp(tool('sec_edgar_get_submissions').parameters?.properties?.cik.pattern as string);
    expect(cik.test('0000320193')).toBe(true);
    expect(cik.test('320193')).toBe(false);
    const period = new RegExp(tool('sec_edgar_get_frames').parameters?.properties?.period.pattern as string);
    for (const p of ['CY2024', 'CY2024Q2', 'CY2024Q4I']) expect(period.test(p)).toBe(true);
    expect(period.test('FY2024')).toBe(false);
    expect(new RegExp(tool('sec_edgar_get_older_filings').parameters?.properties?.file_name.pattern as string).test('CIK0000320193-submissions-001.json')).toBe(true);
    expect(tool('sec_edgar_get_company_concept').parameters?.properties?.taxonomy.enum).toEqual(['us-gaap', 'ifrs-full', 'dei', 'srt', 'invest']);
  });

  it('keeps the profile and the 100 latest filings of a submissions file', () => {
    const n = 150;
    const col = (f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
    const raw = {
      cik: '320193', name: 'Apple Inc.', tickers: ['AAPL'], exchanges: ['Nasdaq'], sic: '3571', sicDescription: 'Electronic Computers', fiscalYearEnd: '0926', addresses: {}, formerNames: [],
      filings: {
        recent: { accessionNumber: col((i) => `acc${i}`), form: col(() => '4'), filingDate: col(() => '2026-10-01'), reportDate: col(() => ''), primaryDocument: col(() => 'x.xml'), primaryDocDescription: col(() => ''), items: col(() => ''), isXBRL: col(() => '0'), acceptanceDateTime: col(() => 'x') },
        files: [{ name: 'CIK0000320193-submissions-001.json', filingCount: 1271 }],
      },
    };
    const out = shape('sec_edgar_get_submissions', raw) as { name: string; recentFilings: { accessionNumber: string[] }; totalRecentFilings: number; olderFilingFiles: unknown[] };
    expect(out.name).toBe('Apple Inc.');
    expect(out.recentFilings.accessionNumber).toHaveLength(100);
    expect(out.recentFilings.accessionNumber[0]).toBe('acc0');
    expect(out.totalRecentFilings).toBe(150);
    expect(out.recentFilings).not.toHaveProperty('acceptanceDateTime');
    expect(out.olderFilingFiles).toEqual([{ name: 'CIK0000320193-submissions-001.json', filingCount: 1271 }]);
  });

  it('reduces company facts to concept names, also for a filer without us-gaap', () => {
    const out = shape('sec_edgar_get_company_facts', { cik: 1, entityName: 'X', facts: { dei: { EntityCommonStockSharesOutstanding: { units: {} } }, 'ifrs-full': { Revenue: { units: {} } } } });
    expect(out).toEqual({ cik: 1, entityName: 'X', taxonomies: ['dei', 'ifrs-full'], dei: ['EntityCommonStockSharesOutstanding'], us_gaap: [], ifrs_full: ['Revenue'], srt: [] });
  });

  it('returns the largest values of a frame first and slims full-text hits', () => {
    const frame = shape('sec_edgar_get_frames', { taxonomy: 'us-gaap', tag: 'Revenues', ccp: 'CY2024', uom: 'USD', label: 'Revenues', description: 'd', pts: 3, data: [{ cik: 1, val: 5 }, { cik: 2, val: 50 }, { cik: 3, val: 20 }] });
    expect((frame.largest as Array<{ cik: number }>).map((d) => d.cik)).toEqual([2, 3, 1]);
    expect(frame.companies).toBe(3);
    const hits = shape('sec_edgar_full_text_search', {
      hits: { total: { value: 189, relation: 'eq' }, hits: [{ _id: '0001163165-25-000012:cop-20241231.htm', _source: { adsh: '0001163165-25-000012', form: '10-K', file_type: '10-K', file_date: '2025-02-18', period_ending: '2024-12-31', display_names: ['CONOCOPHILLIPS (COP) (CIK 0001163165)'], ciks: ['0001163165'], biz_locations: ['Houston, TX'], items: [], sics: ['2911'] } }] },
      aggregations: { form_filter: { buckets: [{ key: '10-K', doc_count: 189 }] } },
    }) as { total: number; hits: Array<Record<string, unknown>>; forms: unknown[] };
    expect(hits.total).toBe(189);
    expect(hits.hits[0]).toMatchObject({ id: '0001163165-25-000012:cop-20241231.htm', accessionNumber: '0001163165-25-000012', form: '10-K', filingDate: '2025-02-18', ciks: ['0001163165'] });
    expect(hits.hits[0]).not.toHaveProperty('sics');
    expect(hits.forms).toEqual([{ form: '10-K', count: 189 }]);
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: every tool is a GET marked read-only and installs enabled', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'sec_edgar_full_text_search', params: { forms: '10-K' } });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain(UA);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SEC_EDGAR_LIVE === '1' && process.env[UA] ? describe : describe.skip;
live('sec-edgar adapter: live (read-only)', () => {
  const headers = { 'User-Agent': process.env[UA] as string, Accept: 'application/json' };
  const getJson = async (url: string) => {
    const res = await fetch(url, { headers });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it('looks up a ticker and reads the submissions, facts, a concept and a frame', async () => {
    const lookup = shape('sec_edgar_search_companies', await getJson(`${EFTS}?keysTyped=nvda`)) as { companies: Array<{ cik: string; tickers: string }> };
    expect(lookup.companies[0]).toMatchObject({ cik: '1045810', tickers: 'NVDA' });
    const subs = shape('sec_edgar_get_submissions', await getJson('https://data.sec.gov/submissions/CIK0000320193.json')) as { name: string; recentFilings: { form: string[] } };
    expect(subs.name).toBe('Apple Inc.');
    expect(subs.recentFilings.form.length).toBeGreaterThan(10);
    const facts = shape('sec_edgar_get_company_facts', await getJson('https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json')) as { us_gaap: string[] };
    expect(facts.us_gaap).toContain('NetIncomeLoss');
    const concept = (await getJson('https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/NetIncomeLoss.json')) as { units: { USD: Array<{ val: number }> } };
    expect(concept.units.USD.length).toBeGreaterThan(10);
    const frame = shape('sec_edgar_get_frames', await getJson('https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2024Q4I.json')) as { largest: Array<{ val: number }>; companies: number };
    expect(frame.largest).toHaveLength(250);
    expect(frame.largest[0].val).toBeGreaterThanOrEqual(frame.largest[1].val);
  }, 120_000);

  it('runs a full-text search and opens the filing folder of a hit', async () => {
    const res = shape('sec_edgar_full_text_search', await getJson(`${EFTS}?q=%22supply%20chain%22&forms=10-K&ciks=0000320193`)) as { total: number; hits: Array<{ accessionNumber: string }> };
    expect(res.total).toBeGreaterThan(0);
    const acc = res.hits[0].accessionNumber.replace(/-/g, '');
    const index = shape('sec_edgar_get_filing_index', await getJson(`https://www.sec.gov/Archives/edgar/data/320193/${acc}/index.json`)) as { files: Array<{ name: string }> };
    expect(index.files.length).toBeGreaterThan(1);
    const older = shape('sec_edgar_get_older_filings', await getJson('https://data.sec.gov/submissions/CIK0000320193-submissions-001.json')) as { filings: number; form: string[] };
    expect(older.filings).toBe(older.form.length);
  }, 120_000);
});
