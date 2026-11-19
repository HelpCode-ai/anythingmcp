import * as adapter from './pitchbook.json';

/**
 * PitchBook Data API (https://documenter.getpostman.com/view/5190535/TzCV1iRc, OpenAPI at
 * https://api.pitchbook.com/api-docs). Header `Authorization: PB-Token <key>`; keys come from the
 * PitchBook account manager, so there is no test account. Every data call costs API credits.
 * Live part (one unauthenticated call and one account call that is not in the priced endpoint list):
 * RUN_PITCHBOOK_LIVE=1 PITCHBOOK_API_KEY=... npx jest src/adapters/intl/pitchbook
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; description?: string; minimum?: number; maximum?: number };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  description: string;
  region: string;
  icon: string;
  category: string;
  docsUrl: string;
  aliases?: string[];
  requiredEnvVars: string[];
  envVarMeta: Record<string, { label: string; kind: string; secret?: boolean; help: string; link: string; pattern: string; patternMessage: string }>;
  verifyHints: Record<string, string>;
  probe?: { tool: string; params?: Record<string, unknown> };
  prerequisites: string;
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments and "$arg" values in query, body and headers.
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
// Text outside `code spans`: the website renders these strings as MDX.
const outsideBackticks = (s: string) => s.replace(/`[^`]*`/g, '');

const SLUG = 'pitchbook';
const BASE = 'https://api.pitchbook.com';
const PREFIX = 'pitchbook_';

// Tool name -> documented GET path ({pb_id} is the vendor's {pbId}).
const PATHS: Record<string, string> = {
  pitchbook_search_entities: '/search',
  pitchbook_search_companies: '/companies/search',
  pitchbook_get_company_bio: '/companies/{pb_id}/bio',
  pitchbook_get_company_financials: '/companies/{pb_id}/financials',
  pitchbook_list_company_deals: '/companies/{pb_id}/deals',
  pitchbook_list_company_investors: '/companies/{pb_id}/investors',
  pitchbook_get_company_latest_financing: '/companies/{pb_id}/most-recent-financing',
  pitchbook_search_deals: '/deals/search',
  pitchbook_get_deal_bio: '/deals/{pb_id}/bio',
  pitchbook_get_deal_details: '/deals/{pb_id}/detailed',
  pitchbook_get_deal_investors: '/deals/{pb_id}/investors/exiters',
  pitchbook_get_deal_valuation: '/deals/{pb_id}/valuation',
  pitchbook_search_investors: '/investors/search',
  pitchbook_get_investor_bio: '/investors/{pb_id}/bio',
  pitchbook_list_investor_investments: '/investors/{pb_id}/investments',
  pitchbook_list_investor_active_investments: '/investors/{pb_id}/active-investments',
  pitchbook_get_investor_preferences: '/investors/{pb_id}/investment-preferences',
  pitchbook_list_investor_funds: '/investors/{pb_id}/funds',
  pitchbook_list_investor_board_seats: '/investors/{pb_id}/board-seats',
  pitchbook_search_funds: '/funds/search',
  pitchbook_get_fund_bio: '/funds/{pb_id}/bio',
  pitchbook_list_fund_investments: '/funds/{pb_id}/investments',
  pitchbook_get_fund_preferences: '/funds/{pb_id}/investment-preferences',
  pitchbook_get_fund_performance: '/funds/{pb_id}/performance',
  pitchbook_get_fund_team: '/funds/{pb_id}/team',
  pitchbook_list_fund_commitments: '/funds/{pb_id}/commitments',
  pitchbook_search_people: '/people/search',
  pitchbook_get_person_bio: '/people/{pb_id}/bio',
  pitchbook_get_person_roles: '/people/{pb_id}/education-work',
  pitchbook_get_person_contact: '/people/{pb_id}/contact',
  pitchbook_get_limits: '/limits',
  pitchbook_list_call_costs: '/calls/costs',
  pitchbook_get_credit_history: '/credits/history',
  pitchbook_list_sandbox_entities: '/sandbox-entities',
  pitchbook_get_lookup_codes: '/lookup-tables',
};
const SEARCH_TOOLS = ['pitchbook_search_entities', 'pitchbook_search_companies', 'pitchbook_search_deals', 'pitchbook_search_investors', 'pitchbook_search_funds', 'pitchbook_search_people'];
const ACCOUNT_TOOLS = ['pitchbook_get_limits', 'pitchbook_list_call_costs', 'pitchbook_get_credit_history', 'pitchbook_list_sandbox_entities', 'pitchbook_get_lookup_codes'];
// Detail tools whose answer holds money objects: they take the optional X-Currency header.
const MONEY_TOOLS = [
  'pitchbook_get_company_bio',
  'pitchbook_get_company_financials',
  'pitchbook_get_company_latest_financing',
  'pitchbook_get_deal_bio',
  'pitchbook_get_deal_details',
  'pitchbook_get_deal_investors',
  'pitchbook_get_deal_valuation',
  'pitchbook_get_investor_bio',
  'pitchbook_get_investor_preferences',
  'pitchbook_list_investor_funds',
  'pitchbook_get_fund_bio',
  'pitchbook_get_fund_preferences',
  'pitchbook_list_fund_commitments',
];

describe('pitchbook adapter: static spec conformance', () => {
  it('is an API-key REST adapter that sends the key with the PB-Token prefix', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe('intl');
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('finance');
    expect(a.docsUrl).toBe('https://documenter.getpostman.com/view/5190535/TzCV1iRc');
    expect(a.requiredEnvVars).toEqual(['PITCHBOOK_API_KEY']);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'PB-Token {{PITCHBOOK_API_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'AnythingMCP' });
    expect((a.aliases ?? []).length).toBeGreaterThan(0);
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('describes the key as a secret credential and refuses a pasted prefix', () => {
    expect(Object.keys(a.envVarMeta)).toEqual(['PITCHBOOK_API_KEY']);
    const m = a.envVarMeta.PITCHBOOK_API_KEY;
    expect(m.kind).toBe('credential');
    expect(m.secret).toBe(true);
    expect(m.link.startsWith('https://')).toBe(true);
    const re = new RegExp(m.pattern);
    expect(re.test('LzUU9xgNjn7avDw5Bd96xNVS0t5dlGuD')).toBe(true);
    expect(re.test('PB-Token LzUU9xgNjn7avDw5Bd96xNVS0t5dlGuD')).toBe(false);
    expect(re.test('')).toBe(false);
    expect(m.patternMessage).toContain('PB-Token');
  });

  it('explains the failures a key can run into', () => {
    expect(Object.keys(a.verifyHints).sort()).toEqual(['401', '402', '403', '404', 'rate_limited']);
    expect(a.verifyHints['402']).toMatch(/credit/i);
    expect(a.verifyHints['403']).toMatch(/contract/i);
    expect(a.prerequisites).toMatch(/account manager|Customer Success Manager/);
  });

  it('probes with an account tool that takes no arguments', () => {
    const p = a.probe!;
    expect(p.tool).toBe('pitchbook_get_limits');
    expect(p.params ?? {}).toEqual({});
    const t = tool(p.tool);
    expect(t.endpointMapping).toEqual({ method: 'GET', path: '/limits' });
    expect(t.parameters?.required ?? []).toEqual([]);
  });

  it('ships exactly the documented GET paths, one tool each', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(PATHS).sort());
    expect(a.tools.length).toBe(35);
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.path}`).toBe(`${t.name}:${PATHS[t.name]}`);
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every tool is prefixed, read-only, switched on, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(`${t.name}:${t.enabled === undefined}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(t.endpointMapping.bodyMapping).toBeUndefined();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of props) expect(`${t.name}:${p}:${/^[a-z][a-z0-9_]*$/.test(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of props) expect(`${t.name}:${p}:${Boolean(t.parameters?.properties?.[p].description)}`).toBe(`${t.name}:${p}:true`);
      const pathParams = [...t.endpointMapping.path.matchAll(/\{(\w+)\}/g)].map(([, p]) => p);
      for (const p of pathParams) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(props).toContain(r);
    }
  });

  it('takes a loose pbId on every detail tool', () => {
    const detail = a.tools.filter((t) => t.endpointMapping.path.includes('{pb_id}'));
    expect(detail.length).toBe(24);
    for (const t of detail) {
      expect(t.parameters?.required).toEqual(['pb_id']);
      const re = new RegExp(t.parameters?.properties?.pb_id.pattern ?? '');
      for (const id of ['51136-75', '52721-65T', '13774-15F', '217377-01P']) expect(`${t.name}:${id}:${re.test(id)}`).toBe(`${t.name}:${id}:true`);
      for (const id of ['', '51136-75/bio', '51136 75', '../limits']) expect(`${t.name}:${id}:${re.test(id)}`).toBe(`${t.name}:${id}:false`);
    }
  });

  it('covers the endpoints known to work, with the vendor query names', () => {
    expect(tool('pitchbook_search_entities').endpointMapping).toEqual({ method: 'GET', path: '/search', queryParams: { query: '$query', page: '$page', perPage: '$per_page' } });
    expect(tool('pitchbook_search_entities').parameters?.required).toEqual(['query']);
    expect(tool('pitchbook_search_people').endpointMapping).toMatchObject({
      path: '/people/search',
      queryParams: { personNames: '$person_names', firmNames: '$firm_names', positionLevel: '$position_level', status: '$status', page: '$page', perPage: '$per_page' },
    });
    expect(tool('pitchbook_search_people').parameters?.properties?.status.enum).toEqual(['active', 'former']);
    expect(tool('pitchbook_search_investors').endpointMapping).toMatchObject({
      path: '/investors/search',
      queryParams: { investorNames: '$investor_names', investorType: '$investor_type', dryPowder: '$dry_powder', country: '$country', currency: '$filter_currency', page: '$page', perPage: '$per_page' },
    });
    expect(tool('pitchbook_get_investor_bio').endpointMapping.path).toBe('/investors/{pb_id}/bio');
    expect(tool('pitchbook_list_investor_investments').endpointMapping).toEqual({ method: 'GET', path: '/investors/{pb_id}/investments' });
    expect(tool('pitchbook_get_investor_preferences').endpointMapping.path).toBe('/investors/{pb_id}/investment-preferences');
    expect(tool('pitchbook_list_fund_investments').endpointMapping).toEqual({ method: 'GET', path: '/funds/{pb_id}/investments' });
  });

  it('pages every search and maps the filters to the vendor names', () => {
    for (const name of SEARCH_TOOLS) {
      const t = tool(name);
      expect(t.endpointMapping.queryParams).toMatchObject({ page: '$page', perPage: '$per_page' });
      expect(t.parameters?.properties?.page).toMatchObject({ type: 'integer', minimum: 1 });
      expect(t.parameters?.properties?.per_page).toMatchObject({ type: 'integer', minimum: 1 });
      expect(t.parameters?.properties?.per_page.maximum).toBeUndefined();
      expect(Object.keys(t.parameters?.properties ?? {}).length).toBeLessThanOrEqual(22);
      expect(t.endpointMapping.headers).toBeUndefined();
    }
    expect(tool('pitchbook_search_companies').endpointMapping.queryParams).toMatchObject({
      companyNames: '$company_names',
      ownershipStatus: '$ownership_status',
      backingStatus: '$backing_status',
      businessStatus: '$business_status',
      stateProvince: '$state_province',
      dateFounded: '$date_founded',
      dealType: '$deal_type',
      dealDate: '$deal_date',
      dealSize: '$deal_size',
      totalRaised: '$total_raised',
      employeeCount: '$employee_count',
      investorNames: '$investor_names',
      currency: '$filter_currency',
    });
    expect(tool('pitchbook_search_deals').endpointMapping.queryParams).toMatchObject({
      dealStatus: '$deal_status',
      preMoneyValuation: '$pre_money_valuation',
      postValuation: '$post_valuation',
      onlyMostRecentTransaction: '$only_most_recent_transaction',
    });
    expect(tool('pitchbook_search_deals').parameters?.properties?.only_most_recent_transaction.enum).toEqual(['True', 'False']);
    expect(tool('pitchbook_search_funds').endpointMapping.queryParams).toMatchObject({
      fundNames: '$fund_names',
      fundStrategy: '$fund_strategy',
      fundStatus: '$fund_status',
      fundSize: '$fund_size',
      vintage: '$vintage',
      fundDomicileCountry: '$fund_domicile_country',
      limitedPartnerNames: '$limited_partner_names',
    });
    // People search has no amount filters, so no filter currency.
    expect(tool('pitchbook_search_people').parameters?.properties?.filter_currency).toBeUndefined();
  });

  it('sends the optional currency as the X-Currency header on the tools that return money, and nowhere else', () => {
    for (const t of a.tools) {
      if (MONEY_TOOLS.includes(t.name)) {
        expect(`${t.name}:${JSON.stringify(t.endpointMapping.headers)}`).toBe(`${t.name}:${JSON.stringify({ 'X-Currency': '$currency' })}`);
        expect(t.parameters?.required ?? []).not.toContain('currency');
      } else {
        expect(`${t.name}:${t.endpointMapping.headers === undefined}`).toBe(`${t.name}:true`);
        expect(t.parameters?.properties?.currency).toBeUndefined();
      }
    }
  });

  it('maps the account and remaining query parameters', () => {
    const costs = tool('pitchbook_list_call_costs');
    expect(costs.endpointMapping.queryParams).toEqual({ pricingModel: '$pricing_model' });
    expect(costs.parameters?.required).toEqual(['pricing_model']);
    expect(costs.parameters?.properties?.pricing_model.enum).toEqual(['SUBSCRIPTION', 'PAY_PER_CALL', 'INTEGRATION']);
    const credits = tool('pitchbook_get_credit_history');
    expect(credits.endpointMapping.queryParams).toEqual({ trailingRange: '$trailing_days', sinceDate: '$since_date' });
    expect(credits.parameters?.properties?.trailing_days).toMatchObject({ type: 'integer', minimum: 1, maximum: 90 });
    const sandbox = tool('pitchbook_list_sandbox_entities');
    expect(sandbox.endpointMapping.queryParams).toEqual({ entityType: '$entity_type' });
    expect(sandbox.parameters?.properties?.entity_type.enum).toEqual(['COMPANIES', 'INVESTORS', 'LIMITED_PARTNERS', 'SERVICE_PROVIDERS', 'PEOPLE', 'DEALS', 'FUNDS', 'CREDIT_NEWS']);
    const lookup = tool('pitchbook_get_lookup_codes');
    expect(lookup.endpointMapping.queryParams).toEqual({ tableNames: '$table_names' });
    expect(lookup.parameters?.required).toEqual(['table_names']);
    expect(tool('pitchbook_get_company_financials').endpointMapping.queryParams).toEqual({ periodType: '$period_type', sinceDate: '$since_date' });
    const performance = tool('pitchbook_get_fund_performance');
    expect(performance.endpointMapping.queryParams).toEqual({ historicalPerformance: '$include_history', sinceDate: '$since_date' });
    expect(performance.parameters?.properties?.include_history).toMatchObject({ type: 'boolean', default: false });
  });

  it('says on every tool how it is billed', () => {
    for (const t of a.tools) {
      if (SEARCH_TOOLS.includes(t.name)) expect(`${t.name}:${/Search allowance/.test(t.description)}`).toBe(`${t.name}:true`);
      else if (ACCOUNT_TOOLS.includes(t.name)) expect(`${t.name}:${/not part of PitchBook's priced endpoint list/.test(t.description)}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${/Billed in PitchBook API credits per call/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    expect(a.instructions).toContain('**Credits and limits**');
    expect(a.instructions).toMatch(/\*\*402\*\*/);
    expect(a.instructions).toMatch(/\*\*403\*\*/);
  });

  it('names every tool in the instructions and keeps the texts MDX-safe', () => {
    expect(a.instructions.startsWith('## PitchBook\n')).toBe(true);
    for (const heading of ['**Setup**', '**Credits and limits**', '**Where to start**']) expect(a.instructions).toContain(heading);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
    const texts: [string, string][] = [
      ['description', a.description],
      ['instructions', a.instructions],
      ['prerequisites', a.prerequisites],
      ...Object.entries(a.verifyHints).map(([k, v]): [string, string] => [`verifyHints.${k}`, v]),
      ...Object.entries(a.envVarMeta).flatMap(([k, v]): [string, string][] => [
        [`${k}.help`, v.help],
        [`${k}.patternMessage`, v.patternMessage],
      ]),
      ...a.tools.map((t): [string, string] => [t.name, t.description]),
      ...a.tools.flatMap((t) => Object.entries(t.parameters?.properties ?? {}).map(([p, v]): [string, string] => [`${t.name}.${p}`, v.description ?? ''])),
    ];
    for (const [where, text] of texts) expect(`${where}:${/[{}<]/.test(outsideBackticks(text))}`).toBe(`${where}:false`);
  });
});

const live = process.env.RUN_PITCHBOOK_LIVE === '1' ? describe : describe.skip;
live('pitchbook adapter: live (account endpoint only, no credits)', () => {
  const key = process.env.PITCHBOOK_API_KEY ?? '';
  const get = (path: string, withKey: boolean) => {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'AnythingMCP' };
    if (withKey) headers.Authorization = `PB-Token ${key}`;
    return fetch(`${BASE}${path}`, { headers });
  };

  it('answers 401 without a key', async () => {
    const res = await get('/limits', false);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason?: string }).reason).toBe('UNAUTHORIZED');
  }, 30_000);

  it('reads the account limits with the PB-Token header', async () => {
    expect(key).not.toBe('');
    const res = await get('/limits', true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limits: { limitType: string }[]; overageChargesAvailable: boolean };
    expect(Array.isArray(body.limits)).toBe(true);
    expect(typeof body.overageChargesAvailable).toBe('boolean');
  }, 30_000);
});
