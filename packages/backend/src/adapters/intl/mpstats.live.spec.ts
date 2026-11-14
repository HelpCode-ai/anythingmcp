import * as adapter from './mpstats.json';

/**
 * MPSTATS Analytics API (mpstats.io/integrations: docs/description, analytics-wb, analytics-oz):
 * X-Mpstats-TOKEN header, https://mpstats.io/api/analytics/v1/{wb|oz}/...; table methods take
 * startRow/endRow/filterModel/sortModel in the JSON body (docs/body-parameters).
 * Live part: MPSTATS_API_TOKEN=... RUN_MPSTATS_LIVE=1 npx jest src/adapters/intl/mpstats
 * (reads only: keyword frequency, one item card and its daily sales; every call counts against the plan's quota).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
const PAGE = { startRow: '$startRow', endRow: '$endRow', filterModel: '$filterModel', sortModel: '$sortModel' };

describe('mpstats adapter: static spec conformance', () => {
  it('sends the token in X-Mpstats-TOKEN to the Analytics API v1', () => {
    expect(a.requiredEnvVars).toEqual(['MPSTATS_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://mpstats.io/api/analytics/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Mpstats-TOKEN', apiKey: '{{MPSTATS_API_TOKEN}}' });
    expect(a.envVarMeta?.MPSTATS_API_TOKEN.secret).toBe(true);
    expect(new RegExp(a.envVarMeta?.MPSTATS_API_TOKEN.pattern as string).test('5a2a5f0e538dd5.6691914852255446e23a9bcac46ee5255625f5d5')).toBe(true);
    expect(a.category).toBe('analytics');
    expect(a.icon).toBe('mpstats');
    for (const t of a.tools) {
      const mp = t.name.startsWith('mpstats_wb_') ? 'wb' : 'oz';
      expect(t.endpointMapping.path.startsWith(`/${mp}/`)).toBe(true);
    }
  });

  it('maps the Wildberries item methods', () => {
    expect(tool('mpstats_wb_find_items').endpointMapping).toEqual({ method: 'POST', path: '/wb/items', queryParams: { ids: '$ids', keyword: '$keyword', d1: '$d1', d2: '$d2' }, bodyMapping: PAGE });
    expect(tool('mpstats_wb_get_item').endpointMapping).toMatchObject({ method: 'GET', path: '/wb/items/{sku}/full' });
    expect(tool('mpstats_wb_get_item_sales').endpointMapping).toEqual({ method: 'GET', path: '/wb/items/{sku}/by_period', queryParams: { d1: '$d1', d2: '$d2', fbs: '$fbs', withSearchStats: '$withSearchStats' } });
    expect(tool('mpstats_wb_get_item_search_stats').endpointMapping.path).toBe('/wb/items/{sku}/search_stats');
    expect(tool('mpstats_wb_list_item_keywords').endpointMapping).toEqual({
      method: 'POST',
      path: '/wb/items/{sku}/keywords',
      queryParams: { d1: '$d1', d2: '$d2', fbs: '$fbs', dateSort: '$dateSort', dateSortDirection: '$dateSortDirection', positionType: '$positionType' },
      bodyMapping: PAGE,
    });
    expect(tool('mpstats_wb_get_item_stock_by_warehouse').endpointMapping).toEqual({ method: 'GET', path: '/wb/items/{sku}/balance/stores', queryParams: { d1: '$d1', d2: '$d2' } });
    expect(tool('mpstats_wb_get_item_stock_by_size').endpointMapping.path).toBe('/wb/items/{sku}/balance/sizes');
    expect(tool('mpstats_wb_get_item_sales_by_warehouse').endpointMapping).toEqual({ method: 'GET', path: '/wb/items/{sku}/sales/stores', queryParams: { d1: '$d1', d2: '$d2', fbs: '$fbs' } });
    expect(tool('mpstats_wb_get_item_sales_by_size').endpointMapping.path).toBe('/wb/items/{sku}/sales/sizes');
    expect(tool('mpstats_wb_get_keyword_frequency').endpointMapping).toEqual({ method: 'GET', path: '/wb/keywords/frequency', queryParams: { keyword: '$keyword' } });
  });

  it('maps competitors, subjects, categories, sellers and brands with the id in the path query parameter', () => {
    const rel = tool('mpstats_wb_list_related_items');
    expect(rel.endpointMapping).toEqual({ method: 'POST', path: '/wb/{relation}/items', queryParams: { path: '$sku', d1: '$d1', d2: '$d2', fbs: '$fbs', newsmode: '$newsmode' }, bodyMapping: PAGE });
    expect(rel.parameters?.properties?.relation.enum).toEqual(['similar', 'in_similar', 'identical_wb', 'identical']);
    expect(tool('mpstats_wb_search_subjects').endpointMapping).toEqual({ method: 'POST', path: '/wb/subject/list', queryParams: { search: '$search', date: '$date', fbs: '$fbs' }, bodyMapping: PAGE });
    expect(tool('mpstats_wb_list_subject_items').endpointMapping).toMatchObject({ method: 'POST', path: '/wb/subject/items', queryParams: { path: '$subject_id' }, bodyMapping: PAGE });
    expect(tool('mpstats_wb_list_subject_breakdown').parameters?.properties?.breakdown.enum).toEqual(['categories', 'brands', 'sellers']);
    expect(tool('mpstats_wb_list_subject_breakdown').endpointMapping).toMatchObject({ path: '/wb/subject/{breakdown}', queryParams: { path: '$subject_id' } });
    expect(tool('mpstats_wb_get_subject_trend').endpointMapping).toEqual({ method: 'POST', path: '/wb/subject/by_date', queryParams: { path: '$subject_id', groupBy: '$groupBy', d1: '$d1', d2: '$d2', fbs: '$fbs' }, bodyMapping: {} });
    expect(tool('mpstats_wb_list_category_items').endpointMapping).toMatchObject({ path: '/wb/category/items', queryParams: { path: '$category' }, bodyMapping: PAGE });
    expect(tool('mpstats_wb_list_category_breakdown').parameters?.properties?.breakdown.enum).toEqual(['categories', 'subjects', 'brands', 'sellers']);
    expect(tool('mpstats_wb_get_category_trend').endpointMapping).toMatchObject({ method: 'POST', path: '/wb/category/by_date', queryParams: { path: '$category', groupBy: '$groupBy' }, bodyMapping: {} });
    expect(tool('mpstats_wb_search_sellers').endpointMapping.path).toBe('/wb/seller/list');
    expect(tool('mpstats_wb_list_seller_items').endpointMapping).toMatchObject({ path: '/wb/seller/items', queryParams: { path: '$seller_id' } });
    expect(tool('mpstats_wb_search_brands').endpointMapping.path).toBe('/wb/brand/list');
    expect(tool('mpstats_wb_list_brand_items').endpointMapping).toMatchObject({ path: '/wb/brand/items', queryParams: { path: '$brand' } });
  });

  it('maps the Ozon methods', () => {
    expect(tool('mpstats_oz_find_items').endpointMapping).toMatchObject({ method: 'POST', path: '/oz/items', bodyMapping: PAGE });
    expect(tool('mpstats_oz_get_item').endpointMapping.path).toBe('/oz/items/{sku}/full');
    expect(tool('mpstats_oz_get_item_sales').endpointMapping.path).toBe('/oz/items/{sku}/by_period');
    expect(tool('mpstats_oz_list_item_keywords').endpointMapping).toEqual({ method: 'GET', path: '/oz/items/{sku}/keywords', queryParams: { d1: '$d1', d2: '$d2' } });
    expect(tool('mpstats_oz_get_item_category_positions').endpointMapping.path).toBe('/oz/items/{sku}/categories');
    expect(tool('mpstats_oz_get_item_stock_by_warehouse').endpointMapping).toEqual({ method: 'GET', path: '/oz/items/{sku}/balance', queryParams: { date: '$date', fbs: '$fbs' } });
    expect(tool('mpstats_oz_get_item_sales_by_warehouse').endpointMapping.path).toBe('/oz/items/{sku}/sales');
    expect(tool('mpstats_oz_list_similar_items').endpointMapping).toMatchObject({ method: 'POST', path: '/oz/identical/items', queryParams: { path: '$sku' } });
    expect(tool('mpstats_oz_search_niches').endpointMapping.path).toBe('/oz/niche/list');
    expect(tool('mpstats_oz_list_niche_items').endpointMapping).toMatchObject({ path: '/oz/niche/items', queryParams: { path: '$niche_id' } });
    expect(tool('mpstats_oz_list_category_items').endpointMapping).toMatchObject({ path: '/oz/category/items', queryParams: { path: '$category' } });
    expect(tool('mpstats_oz_list_category_breakdown').parameters?.properties?.breakdown.enum).toEqual(['categories', 'niches', 'brands', 'sellers']);
    expect(tool('mpstats_oz_get_category_trend').endpointMapping).toMatchObject({ path: '/oz/category/by_date', bodyMapping: {} });
    expect(tool('mpstats_oz_search_sellers').endpointMapping.path).toBe('/oz/seller/list');
    expect(tool('mpstats_oz_list_seller_items').endpointMapping).toMatchObject({ path: '/oz/seller/items', queryParams: { path: '$seller_id' } });
    expect(tool('mpstats_oz_list_brand_items').endpointMapping).toMatchObject({ path: '/oz/brand/items', queryParams: { path: '$brand' } });
  });

  it('always sends a JSON body on POST (the API refuses an empty POST) and pages at most 500 rows', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'POST')) {
      expect(`${t.name}:${t.endpointMapping.bodyMapping !== undefined}`).toBe(`${t.name}:true`);
      const props = t.parameters?.properties ?? {};
      if ('startRow' in props) {
        expect(props.startRow.default).toBe(0);
        expect(props.endRow.default).toBe(100);
      }
    }
    for (const t of a.tools) {
      const fbs = t.parameters?.properties?.fbs;
      if (fbs) expect(fbs.enum).toEqual([0, 1]);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('mpstats_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('only reads: GET tools, and POST reports marked read-only, none switched off', () => {
    for (const t of a.tools) {
      expect(['GET', 'POST']).toContain(t.endpointMapping.method);
      expect(t.enabled).toBeUndefined();
      if (t.endpointMapping.method === 'POST') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'mpstats_wb_get_keyword_frequency', params: { keyword: 'джинсы' } });
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/quota/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_MPSTATS_LIVE === '1' && process.env.MPSTATS_API_TOKEN ? describe : describe.skip;
live('mpstats adapter: live (read-only)', () => {
  const base = 'https://mpstats.io/api/analytics/v1';
  const headers = { 'X-Mpstats-TOKEN': process.env.MPSTATS_API_TOKEN as string, Accept: 'application/json', 'Content-Type': 'application/json' };
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  it('reads keyword frequency, an item found by keyword, and its daily sales', async () => {
    const freq = await fetch(`${base}/wb/keywords/frequency?keyword=${encodeURIComponent('джинсы')}`, { headers });
    expect(freq.status).toBe(200);
    expect(Array.isArray(await freq.json())).toBe(true);
    const found = (await (
      await fetch(`${base}/wb/items?keyword=${encodeURIComponent('джинсы')}`, { method: 'POST', headers, body: JSON.stringify({ startRow: 0, endRow: 1 }) })
    ).json()) as { data: Array<{ id: number }> };
    const sku = found.data[0].id;
    expect(sku).toBeTruthy();
    const sales = await fetch(`${base}/wb/items/${sku}/by_period?d1=${day(8)}&d2=${day(1)}`, { headers });
    expect(sales.status).toBe(200);
  }, 60_000);
});
