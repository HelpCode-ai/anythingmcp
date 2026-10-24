import * as adapter from './sportmonks.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; healthcheckPath: string };
  probe: { tool: string };
  tools: Array<{
    name: string;
    parameters: { properties: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
    responseMapping: { transform: { mode: string; expression: string } };
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('sportmonks adapter: static spec conformance', () => {
  it('sends the token in the Authorization header to API v3', () => {
    expect(a.connector.baseUrl).toBe('https://api.sportmonks.com/v3');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{SPORTMONKS_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SPORTMONKS_API_TOKEN']);
  });

  it('checks the connection with the plan league list', () => {
    expect(a.probe.tool).toBe('sportmonks_list_my_leagues');
    expect(a.connector.healthcheckPath).toBe('/my/leagues');
  });

  it('is read-only', () => {
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('GET');
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

  it('maps pre-match odds of one fixture by market and by bookmaker', () => {
    const byMarket = tool('sportmonks_get_prematch_odds_by_market');
    expect(byMarket.endpointMapping.path).toBe('/football/odds/pre-match/fixtures/{fixture_id}/markets/{market_id}');
    expect(byMarket.parameters.required).toEqual(['fixture_id', 'market_id']);
    expect(byMarket.endpointMapping.queryParams).toEqual({ include: '$include', select: '$select', filters: '$filters', locale: '$locale' });
    const byBookmaker = tool('sportmonks_get_prematch_odds_by_bookmaker');
    expect(byBookmaker.endpointMapping.path).toBe('/football/odds/pre-match/fixtures/{fixture_id}/bookmakers/{bookmaker_id}');
    expect(byBookmaker.parameters.required).toEqual(['fixture_id', 'bookmaker_id']);
    expect(byBookmaker.endpointMapping.queryParams).toEqual(byMarket.endpointMapping.queryParams);
  });

  it('keeps data, paging, rate limit and the plan message, and drops the subscription block', () => {
    const raw = {
      data: [{ id: 9, name: 'Championship' }],
      pagination: { count: 1, per_page: 25, current_page: 1, next_page: null, has_more: false, next_cursor: null },
      subscription: [{ meta: [], plans: [{ plan: 'Pro' }] }],
      rate_limit: { resets_in_seconds: 3500, remaining: 2999, requested_entity: 'League' },
      timezone: 'UTC',
    };
    const out = applyResponseTransform(raw, tool('sportmonks_list_leagues').responseMapping);
    expect(out.value).toEqual({
      data: [{ id: 9, name: 'Championship' }],
      pagination: { has_more: false, current_page: 1, next_page: null },
      rate_limit: { remaining: 2999, resets_in_seconds: 3500, requested_entity: 'League' },
    });
    const empty = applyResponseTransform(
      { message: 'No result(s) found matching your request.', subscription: [], rate_limit: { remaining: 1 } },
      tool('sportmonks_get_league').responseMapping,
    );
    expect((empty.value as any).message).toContain('No result');
  });
});

// RUN_SPORTMONKS_LIVE=1 SPORTMONKS_API_TOKEN=<token> npx jest src/adapters/intl/sportmonks.live.spec.ts
const live = process.env.RUN_SPORTMONKS_LIVE === '1' && !!process.env.SPORTMONKS_API_TOKEN;
(live ? describe : describe.skip)('sportmonks adapter: live', () => {
  it('lists the leagues of the plan', async () => {
    const res = await fetch(`${a.connector.baseUrl}/my/leagues`, { headers: { Authorization: String(process.env.SPORTMONKS_API_TOKEN) } });
    expect(res.status).toBe(200);
    const out = applyResponseTransform(await res.json(), tool('sportmonks_list_my_leagues').responseMapping).value as any;
    expect(Array.isArray(out.data)).toBe(true);
  });
});
