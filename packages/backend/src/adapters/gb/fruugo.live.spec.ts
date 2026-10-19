import * as adapter from './fruugo.json';

/**
 * Fruugo Order API and Stock Status API (fruugo.atlassian.net/wiki/spaces/RR): HTTP
 * Basic with the Retailer Portal login, answers in XML, order download window
 * at most 60 days, stock feed in pages of 1,000.
 * Live part: FRUUGO_USERNAME=... FRUUGO_PASSWORD=... RUN_FRUUGO_LIVE=1 npx jest src/adapters/gb/fruugo
 */

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
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
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  return out;
};
const PREFIX = 'fruugo_';
const WRITES: string[] = ["fruugo_confirm_order", "fruugo_ship_order"];
// Tool names of the customers' own connectors for this API on the Cloud (read 19 Oct 2026).
const HAND_BUILT = ["fruugo_list_orders"];

describe('fruugo adapter: static spec conformance', () => {
  it('signs with HTTP Basic against www.fruugo.com', () => {
    expect(a.requiredEnvVars).toEqual(['FRUUGO_USERNAME', 'FRUUGO_PASSWORD']);
    expect(a.connector.baseUrl).toBe('https://www.fruugo.com');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{FRUUGO_USERNAME}}', password: '{{FRUUGO_PASSWORD}}' });
    expect(a.envVarMeta.FRUUGO_PASSWORD.secret).toBe(true);
  });

  it('uses the v2 order download and pages the stock feed by default', () => {
    expect(tool('fruugo_download_orders').endpointMapping).toMatchObject({ method: 'GET', path: '/orders/download/v2', queryParams: { from: '$from', to: '$to' } });
    expect(tool('fruugo_download_orders').parameters?.required).toEqual(['from']);
    expect(a.instructions).toContain('60 days');
    expect(tool('fruugo_list_stock').endpointMapping).toMatchObject({ method: 'GET', path: '/stockstatus-api', queryParams: { page: '$page' } });
    expect((tool('fruugo_list_stock').parameters?.properties?.page as { default: number }).default).toBe(0);
  });

  it('confirm and ship post form fields; cancel and return (which refund) are not offered', () => {
    for (const [name, path] of [['fruugo_confirm_order', '/orders/confirm'], ['fruugo_ship_order', '/orders/ship']]) {
      expect(tool(name).endpointMapping).toMatchObject({ method: 'POST', path, bodyEncoding: 'form-urlencoded' });
      expect(tool(name).endpointMapping.bodyMapping?.orderId).toBe('$order_id');
    }
    expect(tool('fruugo_ship_order').endpointMapping.bodyMapping).toMatchObject({ trackingCode: '$tracking_code', trackingUrl: '$tracking_url' });
    expect(a.tools.some((t) => /\/orders\/(cancel|return)$/.test(t.endpointMapping.path))).toBe(false);
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

  it('writes are installed switched off and annotated; reads are not switched off', () => {
    const writes = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (WRITES.includes(t.name)) expect(t.annotations?.readOnlyHint).toBe(false);
      else {
        expect(t.enabled).toBeUndefined();
        if (t.endpointMapping.method !== 'GET') expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(WRITES).not.toContain(a.probe.tool);
    tool(a.probe.tool);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FRUUGO_LIVE === '1' && process.env.FRUUGO_USERNAME ? describe : describe.skip;
live('fruugo adapter: live (read-only)', () => {
  const auth = Buffer.from(`${process.env.FRUUGO_USERNAME}:${process.env.FRUUGO_PASSWORD}`).toString('base64');
  it('downloads orders of the last 30 days as XML and refuses a window over 60 days', async () => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const ok = await fetch(`${a.connector.baseUrl}/orders/download/v2?from=${from}`, { headers: { Authorization: `Basic ${auth}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/xml/);
    const tooLong = await fetch(`${a.connector.baseUrl}/orders/download/v2?from=2026-01-01&to=2026-06-01`, { headers: { Authorization: `Basic ${auth}` } });
    expect(tooLong.status).toBe(400);
  }, 60_000);
});
