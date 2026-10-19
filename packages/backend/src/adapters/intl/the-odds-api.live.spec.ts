import * as adapter from './the-odds-api.json';

const a = adapter as unknown as {
  slug: string;
  description: string;
  instructions: string;
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; healthcheckPath: string };
  probe: { tool: string };
  tools: Array<{
    name: string;
    description: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; exposeHeaders?: string[] };
    annotations?: { readOnlyHint?: boolean };
  }>;
};

describe('the-odds-api adapter: static spec conformance', () => {
  it('is the-odds-api.com v4, not the odds-api.io adapter', () => {
    expect(a.slug).toBe('the-odds-api');
    expect(a.connector.baseUrl).toBe('https://api.the-odds-api.com/v4');
    expect(a.description).toContain('Not the odds-api.io service');
    expect(a.instructions).toContain('`odds-api`');
  });

  it('sends the key as the apiKey query parameter, never as a tool argument', () => {
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ apiKey: '{{THE_ODDS_API_KEY}}' });
    for (const t of a.tools) expect(Object.keys(t.parameters.properties)).not.toContain('apiKey');
  });

  it('checks the connection with the free sports list', () => {
    expect(a.probe.tool).toBe('the_odds_api_list_sports');
    expect(a.connector.healthcheckPath).toBe('/sports');
  });

  it('shows the credit balance headers on every tool', () => {
    for (const t of a.tools) expect(t.endpointMapping.exposeHeaders).toEqual(['x-requests-remaining', 'x-requests-used', 'x-requests-last']);
  });

  it('is GET only; the 10-credit historical odds tools ask before running', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
    const asking = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(asking.sort()).toEqual(['the_odds_api_get_historical_event_odds', 'the_odds_api_get_historical_odds']);
  });

  it('every tool states its credit cost', () => {
    for (const t of a.tools) expect(`${t.name}:${/credit/i.test(t.description)}`).toBe(`${t.name}:true`);
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values(m.queryParams ?? {})) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters.properties)) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });
});

// Spends no credits (/sports is free): RUN_THE_ODDS_API_LIVE=1 THE_ODDS_API_KEY=<key> npx jest src/adapters/intl/the-odds-api.live.spec.ts
const live = process.env.RUN_THE_ODDS_API_LIVE === '1' && !!process.env.THE_ODDS_API_KEY;
(live ? describe : describe.skip)('the-odds-api adapter: live, free call only', () => {
  it('lists sports and reports the credit balance', async () => {
    const res = await fetch(`${a.connector.baseUrl}/sports?apiKey=${encodeURIComponent(String(process.env.THE_ODDS_API_KEY))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-requests-last')).toBe('0');
    const sports = (await res.json()) as Array<{ key: string }>;
    expect(sports.length).toBeGreaterThan(0);
  });
});
