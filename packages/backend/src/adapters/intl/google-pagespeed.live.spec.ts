import * as adapter from './google-pagespeed.json';

/**
 * Google PageSpeed Insights API v5 (https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed)
 * and Chrome UX Report API (https://developer.chrome.com/docs/crux/api, https://developer.chrome.com/docs/crux/history-api).
 * One Google API key as the key query parameter for both hosts; the CrUX tools carry an absolute path.
 * Live part: RUN_GOOGLE_PAGESPEED_LIVE=1 GOOGLE_PAGESPEED_API_KEY=... npx jest src/adapters/intl/google-pagespeed
 */

type Prop = { type?: string; default?: unknown; pattern?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[] } };
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: { readOnlyHint?: boolean };
  parameters?: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown>; timeoutMs?: number };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  category: string;
  aliases?: string[];
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  verifyHints?: Record<string, unknown>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
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
const SLUG = 'google-pagespeed';
const REGION = 'intl';
const BASE = 'https://www.googleapis.com/pagespeedonline/v5';
const PREFIX = 'google_pagespeed_';
const ENV_VARS: string[] = ['GOOGLE_PAGESPEED_API_KEY'];
// Tools installed switched off.
const OFF: string[] = [];
// name: [method, path, required arguments]
const TOOLS: Record<string, [string, string, string[]]> = {
  google_pagespeed_get_scores: ['GET', '/runPagespeed', ['url']],
  google_pagespeed_run_audit: ['GET', '/runPagespeed', ['url']],
  google_pagespeed_query_crux_record: ['POST', 'https://chromeuxreport.googleapis.com/v1/records:queryRecord', []],
  google_pagespeed_query_crux_history: ['POST', 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord', []],
};

describe('google-pagespeed adapter: static spec conformance', () => {
  it('has the expected envelope and authentication', () => {
    expect(a.slug).toBe(SLUG);
    expect(a.region).toBe(REGION);
    expect(a.icon).toBe(SLUG);
    expect(a.category).toBe('analytics');
    expect(a.requiredEnvVars).toEqual(['GOOGLE_PAGESPEED_API_KEY']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{GOOGLE_PAGESPEED_API_KEY}}' });
    expect(a.envVarMeta?.GOOGLE_PAGESPEED_API_KEY).toMatchObject({ secret: true, kind: 'credential' });
    for (const alias of a.aliases ?? []) expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('probes with a read tool and arguments it declares', () => {
    const p = a.probe!;
    const t = tool(p.tool);
    expect(t.enabled).toBeUndefined();
    const props = Object.keys(t.parameters?.properties ?? {});
    for (const k of Object.keys(p.params ?? {})) expect(props).toContain(k);
    for (const r of t.parameters?.required ?? []) expect(Object.keys(p.params ?? {})).toContain(r);
  });

  it('pins the method, path and required arguments of every tool', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const [name, [method, path, required]] of Object.entries(TOOLS)) {
      const t = tool(name);
      expect(`${name}:${t.endpointMapping.method}`).toBe(`${name}:${method}`);
      expect(`${name}:${t.endpointMapping.path}`).toBe(`${name}:${path}`);
      expect(`${name}:${(t.parameters?.required ?? []).join(',')}`).toBe(`${name}:${required.join(',')}`);
    }
  });

  it('every tool is prefixed, described, maps every declared argument and requires its path parameters', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p) || ENV_VARS.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('installs exactly the expected tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...OFF].sort());
  });

  it('documents every tool in the instructions and has no em dash', () => {
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });

  it('runs PageSpeed Insights with a long timeout and trims the answer on the server', () => {
    for (const name of ['google_pagespeed_get_scores', 'google_pagespeed_run_audit']) {
      const t = tool(name);
      expect(t.endpointMapping.queryParams).toEqual({ url: '$url', strategy: '$strategy', category: '$category', locale: '$locale' });
      expect(t.endpointMapping.timeoutMs).toBe(120000);
      expect(t.parameters?.properties?.strategy).toMatchObject({ enum: ['MOBILE', 'DESKTOP'], default: 'MOBILE' });
      expect(t.parameters?.properties?.category.items?.enum).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']);
    }
    const mapping = (name: string) => (a.tools.find((t) => t.name === name) as unknown as { responseMapping: { transform: { include?: string[]; exclude?: string[] } } }).responseMapping.transform;
    expect(mapping('google_pagespeed_get_scores').include).toEqual(expect.arrayContaining(['loadingExperience', 'originLoadingExperience', 'lighthouseResult.categories.performance.score', 'lighthouseResult.audits.largest-contentful-paint.numericValue', 'lighthouseResult.audits.cumulative-layout-shift.displayValue']));
    expect(mapping('google_pagespeed_run_audit').exclude).toEqual(expect.arrayContaining(['lighthouseResult.audits.full-page-screenshot', 'lighthouseResult.fullPageScreenshot']));
  });

  it('builds the CrUX bodies with the documented field names and values', () => {
    const rec = tool('google_pagespeed_query_crux_record');
    const hist = tool('google_pagespeed_query_crux_history');
    expect(rec.endpointMapping.path).toBe('https://chromeuxreport.googleapis.com/v1/records:queryRecord');
    expect(hist.endpointMapping.path).toBe('https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord');
    expect(rec.endpointMapping.bodyMapping).toEqual({ origin: '$origin', url: '$url', formFactor: '$form_factor', metrics: '$metrics' });
    expect(hist.endpointMapping.bodyMapping).toEqual({ origin: '$origin', url: '$url', formFactor: '$form_factor', metrics: '$metrics', collectionPeriodCount: '$collection_period_count' });
    for (const t of [rec, hist]) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.endpointMapping.queryParams).toBeUndefined();
      expect(t.parameters?.required).toBeUndefined();
      expect(t.parameters?.properties?.form_factor.enum).toEqual(['PHONE', 'DESKTOP', 'TABLET']);
      // No enum on the metric names: Google adds and retires them, and an enum would refuse a valid one.
      const metrics = t.parameters?.properties?.metrics as { type?: string; items?: { type?: string; enum?: unknown[] }; description?: string };
      expect(metrics.type).toBe('array');
      expect(metrics.items?.enum).toBeUndefined();
      for (const m of ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift', 'first_contentful_paint', 'experimental_time_to_first_byte']) expect(metrics.description).toContain(m);
    }
    expect(hist.parameters?.properties?.collection_period_count).toMatchObject({ minimum: 1, maximum: 40 });
    expect(a.probe).toEqual({ tool: 'google_pagespeed_query_crux_record', params: { origin: 'https://www.google.com', form_factor: 'PHONE', metrics: ['largest_contentful_paint'] } });
    expect(a.instructions).toContain('exactly one');
  });
});

const live = process.env.RUN_GOOGLE_PAGESPEED_LIVE === '1' && process.env.GOOGLE_PAGESPEED_API_KEY ? describe : describe.skip;
live('google-pagespeed adapter: live (read-only, free quota)', () => {
  const key = encodeURIComponent(process.env.GOOGLE_PAGESPEED_API_KEY ?? '');
  const crux = (method: string, body: unknown) => fetch(`https://chromeuxreport.googleapis.com/v1/records:${method}?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('reads a CrUX record and history, and gets 400 for origin and url together', async () => {
    const rec = (await (await crux('queryRecord', { origin: 'https://www.google.com', formFactor: 'PHONE', metrics: ['largest_contentful_paint'] })).json()) as { record: { metrics: { largest_contentful_paint: { percentiles: { p75: number } } } } };
    expect(Number(rec.record.metrics.largest_contentful_paint.percentiles.p75)).toBeGreaterThan(0);
    const hist = (await (await crux('queryHistoryRecord', { origin: 'https://www.google.com', metrics: ['cumulative_layout_shift'], collectionPeriodCount: 4 })).json()) as { record: { collectionPeriods: unknown[] } };
    expect(hist.record.collectionPeriods).toHaveLength(4);
    const both = await crux('queryRecord', { origin: 'https://www.google.com', url: 'https://www.google.com/' });
    expect(both.status).toBe(400);
  }, 60_000);
  it('runs a PageSpeed Insights test', async () => {
    const res = (await (await fetch(`${BASE}/runPagespeed?url=${encodeURIComponent('https://example.com')}&strategy=MOBILE&category=PERFORMANCE&key=${key}`)).json()) as { lighthouseResult: { categories: { performance: { score: number } } } };
    expect(res.lighthouseResult.categories.performance.score).toBeGreaterThan(0);
  }, 120_000);
});
