import * as adapter from './zerion.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Zerion API (developers.zerion.io, OpenAPI at developers.zerion.io/openapi-v1.yaml):
 * base https://api.zerion.io/v1, HTTP Basic auth with the API key as user name and
 * an empty password, JSON:API responses with cursor paging through links.next.
 * Live part (reads only: chains, gas prices, a token, a public wallet's portfolio and positions):
 *   ZERION_API_KEY=... RUN_ZERION_LIVE=1 npx jest src/adapters/intl/zerion
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
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
const PREFIX = 'zerion_';
const W = '/v1/wallets/{address}';

describe('zerion adapter: static spec conformance', () => {
  it('authenticates with Basic auth, the key as user name and an empty password', () => {
    expect(a.requiredEnvVars).toEqual(['ZERION_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.zerion.io');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{ZERION_API_KEY}}', password: '' });
    expect(a.envVarMeta?.ZERION_API_KEY.secret).toBe(true);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).toMatch(/^\/v1\//);
      expect(t.endpointMapping.path).not.toMatch(/swap|subscription|wallet-sets/);
    }
  });

  it('maps the wallet endpoints with the documented filter[...] and page[...] keys', () => {
    expect(tool('zerion_get_wallet_portfolio').endpointMapping).toEqual({ method: 'GET', path: `${W}/portfolio`, queryParams: { 'filter[positions]': '$positions', currency: '$currency' } });
    expect(tool('zerion_list_wallet_positions').endpointMapping).toMatchObject({
      path: `${W}/positions/`,
      queryParams: { 'filter[positions]': '$positions', 'filter[chain_ids]': '$chain_ids', 'filter[trash]': '$trash', 'filter[position_types]': '$position_types', sort: '$sort', currency: '$currency' },
    });
    expect(tool('zerion_list_wallet_transactions').endpointMapping).toMatchObject({
      path: `${W}/transactions/`,
      queryParams: { 'filter[operation_types]': '$operation_types', 'filter[min_mined_at]': '$min_mined_at', 'filter[max_mined_at]': '$max_mined_at', 'page[size]': '$page_size', 'page[after]': '$page_after' },
    });
    expect(tool('zerion_get_wallet_pnl').endpointMapping).toMatchObject({ path: `${W}/pnl`, queryParams: { since: '$since', till: '$till', 'filter[chain_ids]': '$chain_ids' } });
    expect(tool('zerion_get_wallet_chart').endpointMapping.path).toBe(`${W}/charts/{chart_period}`);
    expect(tool('zerion_get_wallet_chart').parameters?.properties?.chart_period.enum).toEqual(['hour', 'day', 'week', 'month', '3months', '6months', 'year', '5years', 'max']);
    expect(tool('zerion_list_wallet_nft_positions').endpointMapping).toMatchObject({ path: `${W}/nft-positions/`, queryParams: { 'filter[collections_ids]': '$collections_ids', 'page[after]': '$page_after' } });
    expect(tool('zerion_list_wallet_nft_collections').endpointMapping.path).toBe(`${W}/nft-collections/`);
    expect(tool('zerion_get_wallet_nft_portfolio').endpointMapping.path).toBe(`${W}/nft-portfolio`);
  });

  it('maps the token, chain and gas endpoints', () => {
    expect(tool('zerion_list_fungibles').endpointMapping).toMatchObject({ path: '/v1/fungibles/', queryParams: { 'filter[search_query]': '$search_query', 'filter[implementation_chain_id]': '$implementation_chain_id', sort: '$sort' } });
    expect(tool('zerion_get_fungible').endpointMapping).toEqual({ method: 'GET', path: '/v1/fungibles/{fungible_id}', queryParams: { currency: '$currency' } });
    expect(tool('zerion_get_fungible_chart').endpointMapping.path).toBe('/v1/fungibles/{fungible_id}/charts/{chart_period}');
    expect(tool('zerion_get_fungible_by_implementation').endpointMapping).toEqual({ method: 'GET', path: '/v1/fungibles/by-implementation', queryParams: { implementation: '$implementation', currency: '$currency' } });
    expect(tool('zerion_list_chains').endpointMapping).toEqual({ method: 'GET', path: '/v1/chains/' });
    expect(tool('zerion_get_chain').endpointMapping.path).toBe('/v1/chains/{chain_id}');
    expect(tool('zerion_list_gas_prices').endpointMapping).toEqual({ method: 'GET', path: '/v1/gas-prices/', queryParams: { 'filter[chain_ids]': '$chain_ids', 'filter[gas_types]': '$gas_types' } });
  });

  it('drops icons, descriptions and contract lists from positions and transactions, keeping the amounts', () => {
    const fi = { id: 'usdc', symbol: 'USDC', description: 'long text', icon: { url: 'x' }, implementations: [{ chain_id: 'base' }] };
    const pos = applyResponseTransform(
      { data: [{ id: 'p1', attributes: { value: 10, quantity: { float: 10 }, fungible_info: fi }, relationships: { chain: { data: { id: 'base' } } } }] },
      tool('zerion_list_wallet_positions').responseMapping as never,
    ).value;
    expect(pos).toEqual({ data: [{ id: 'p1', attributes: { value: 10, quantity: { float: 10 }, fungible_info: { id: 'usdc', symbol: 'USDC' } }, relationships: { chain: { data: { id: 'base' } } } }] });
    const tx = applyResponseTransform(
      { links: { next: 'n' }, data: [{ id: 't1', attributes: { hash: '0x1', fee: { fungible_info: fi, value: 0.1 }, transfers: [{ direction: 'out', value: 5, fungible_info: fi }] } }] },
      tool('zerion_list_wallet_transactions').responseMapping as never,
    ).value;
    expect(tx).toEqual({ links: { next: 'n' }, data: [{ id: 't1', attributes: { hash: '0x1', fee: { fungible_info: { id: 'usdc', symbol: 'USDC' }, value: 0.1 }, transfers: [{ direction: 'out', value: 5, fungible_info: { id: 'usdc', symbol: 'USDC' } }] } }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only: no tool writes, none is switched off', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ZERION_LIVE === '1' && process.env.ZERION_API_KEY ? describe : describe.skip;
live('zerion adapter: live (read-only)', () => {
  // A public wallet used in Zerion's own documentation examples.
  const wallet = '0x42b9df65b219b3dd36ff330a4dd8f327a6ada990';
  const auth = `Basic ${Buffer.from(`${process.env.ZERION_API_KEY}:`).toString('base64')}`;
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: unknown; links?: { next?: string } };
  };
  it('reads chains, gas prices, a token and a wallet portfolio and positions', async () => {
    const chains = (await get('/v1/chains/')).data as Array<{ id: string }>;
    expect(chains.map((c) => c.id)).toContain('ethereum');
    expect(Array.isArray((await get('/v1/gas-prices/?filter[chain_ids]=ethereum')).data)).toBe(true);
    expect((await get('/v1/fungibles/eth')).data).toMatchObject({ id: 'eth' });
    const portfolio = (await get(`/v1/wallets/${wallet}/portfolio?currency=usd`)).data as { attributes: { total: { positions: number } } };
    expect(typeof portfolio.attributes.total.positions).toBe('number');
    const positions = (await get(`/v1/wallets/${wallet}/positions/?filter[positions]=only_simple&currency=usd`)).data as unknown[];
    expect(Array.isArray(positions)).toBe(true);
  }, 60_000);
});
