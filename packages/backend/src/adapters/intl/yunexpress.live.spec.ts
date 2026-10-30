import * as adapter from './yunexpress.json';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';

/**
 * YunExpress OMS API (云途物流 OMS 1.4.x): base http://oms.api.yunexpress.com (the host does
 * not answer HTTPS), `Authorization: Basic base64("<customer code>&<API secret>")`, answers
 * { Code: "0000", Message, Item | Items, RequestId }. A wrong token gets HTTP 421 with
 * { ResultCode: "401", ResultDesc }.
 * Live part (reads only: countries, shipping methods, goods types, a quote):
 *   YUNEXPRESS_API_TOKEN=$(printf '%s' 'C12345&secret' | base64) RUN_YUNEXPRESS_LIVE=1 \
 *   npx jest src/adapters/intl/yunexpress
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyTemplate?: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings and body templates.
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
  walk(m.bodyTemplate ?? '');
  return out;
};
const PREFIX = 'yunexpress_';

describe('yunexpress adapter: static spec conformance', () => {
  it('sends Authorization: Basic with the Base64 token of customer code&secret', () => {
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.requiredEnvVars).toEqual(['YUNEXPRESS_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('http://oms.api.yunexpress.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: 'Basic {{YUNEXPRESS_API_TOKEN}}' });
    const meta = a.envVarMeta?.YUNEXPRESS_API_TOKEN;
    expect(meta?.secret).toBe(true);
    const re = new RegExp(meta?.pattern ?? '');
    expect(re.test(Buffer.from('C88888&JCJaDQ68amA=').toString('base64'))).toBe(true);
    expect(re.test('C88888&JCJaDQ68amA=')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/api\//);
  });

  it('maps the OMS lookup, quote, order and tracking routes', () => {
    expect(tool('yunexpress_list_countries').endpointMapping).toEqual({ method: 'GET', path: '/api/Common/GetCountry' });
    expect(tool('yunexpress_list_shipping_methods').endpointMapping).toEqual({ method: 'GET', path: '/api/Common/GetShippingMethods', queryParams: { CountryCode: '$CountryCode' } });
    expect(tool('yunexpress_list_goods_types').endpointMapping).toEqual({ method: 'GET', path: '/api/Common/GetGoodsType' });
    expect(tool('yunexpress_get_price_quote').endpointMapping).toMatchObject({ method: 'GET', path: '/api/Freight/GetPriceTrial', queryParams: { CountryCode: '$CountryCode', Weight: '$Weight', Length: '$Length', Width: '$Width', Height: '$Height', PackageType: '$PackageType' } });
    expect(tool('yunexpress_get_price_quote').parameters?.required).toEqual(['CountryCode', 'Weight']);
    expect(tool('yunexpress_get_tracking_numbers').endpointMapping).toEqual({ method: 'GET', path: '/api/Waybill/GetTrackingNumber', queryParams: { CustomerOrderNumber: '$CustomerOrderNumber' } });
    for (const [name, path] of [
      ['yunexpress_get_order', '/api/WayBill/GetOrder'],
      ['yunexpress_get_sender', '/api/WayBill/GetSender'],
      ['yunexpress_get_tracking', '/api/Tracking/GetTrackInfo'],
      ['yunexpress_get_full_tracking', '/api/Tracking/GetTrackAllInfo'],
    ]) {
      expect(tool(name).endpointMapping).toEqual({ method: 'GET', path, queryParams: { OrderNumber: '$OrderNumber' } });
    }
    expect(tool('yunexpress_get_shipping_fee').endpointMapping).toEqual({ method: 'GET', path: '/api/Freight/GetShippingFeeDetail', queryParams: { wayBillNumber: '$wayBillNumber' } });
  });

  it('sends the label, carrier and create-order bodies as bare JSON arrays', () => {
    expect(tool('yunexpress_get_labels').endpointMapping).toEqual({ method: 'POST', path: '/api/Label/Print', bodyTemplate: '${orderNumbers}' });
    expect(tool('yunexpress_get_carriers').endpointMapping).toEqual({ method: 'POST', path: '/api/Waybill/GetCarrier', bodyTemplate: '${orderNumbers}' });
    expect(tool('yunexpress_create_orders').endpointMapping).toEqual({ method: 'POST', path: '/api/WayBill/CreateOrder', bodyTemplate: '${orders}' });
    for (const n of ['yunexpress_get_labels', 'yunexpress_get_carriers']) expect(tool(n).parameters?.properties?.orderNumbers.type).toBe('array');
    expect(tool('yunexpress_create_orders').parameters?.properties?.orders.type).toBe('array');
    expect(tool('yunexpress_update_weight').endpointMapping).toEqual({ method: 'POST', path: '/api/WayBill/UpdateWeight', bodyMapping: { OrderNumber: '$OrderNumber', Weight: '$Weight' } });
    expect(tool('yunexpress_intercept_order').endpointMapping).toEqual({ method: 'POST', path: '/api/WayBill/Intercept', bodyMapping: { OrderType: '$OrderType', OrderNumber: '$OrderNumber', Remark: '$Remark' } });
    expect(tool('yunexpress_delete_order').endpointMapping).toEqual({ method: 'POST', path: '/api/WayBill/Delete', bodyMapping: { OrderType: '$OrderType', OrderNumber: '$OrderNumber' } });
    expect(tool('yunexpress_delete_order').parameters?.properties?.OrderType.enum).toEqual([1, 2, 3]);
  });

  it('turns OMS error codes into failures and passes 0000 and partial success through', () => {
    const rules = a.connector.config?.errorWhen;
    expect(() => assertNoResponseBodyError({ Code: '0000', Message: 'ok', Items: [] }, rules)).not.toThrow();
    expect(() => assertNoResponseBodyError({ Code: '1011', Message: 'partial', Item: [] }, rules)).not.toThrow();
    for (const code of ['1002', '1004', '2004', '10000', '9999', '1006']) expect(() => assertNoResponseBodyError({ Code: code, Message: `m${code}` }, rules)).toThrow(new RegExp(`m${code}`));
    expect(() => assertNoResponseBodyError({ Item: null, ResultCode: '401', ResultDesc: 'denied' }, rules)).toThrow(/denied/);
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

  it('marks label and carrier lookups read-only although they are POST, and writes as writes', () => {
    const reads = new Set(['yunexpress_get_labels', 'yunexpress_get_carriers']);
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || reads.has(t.name);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:${read}`);
    }
    expect(tool('yunexpress_delete_order').enabled).toBe(false);
    expect(tool('yunexpress_delete_order').annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const token = process.env.YUNEXPRESS_API_TOKEN;
const live = process.env.RUN_YUNEXPRESS_LIVE === '1' && token ? describe : describe.skip;
live('yunexpress adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Basic ${token}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { Code: string; Items?: unknown[]; Item?: unknown };
    expect(json.Code).toBe('0000');
    return json;
  };
  it('reads countries, shipping methods, goods types and a quote', async () => {
    expect(Array.isArray((await get('/api/Common/GetCountry')).Items)).toBe(true);
    expect(Array.isArray((await get('/api/Common/GetShippingMethods?CountryCode=DE')).Items)).toBe(true);
    expect((await get('/api/Common/GetGoodsType')).Items).toBeDefined();
    expect((await get('/api/Freight/GetPriceTrial?CountryCode=DE&Weight=0.25&Length=20&Width=15&Height=5&PackageType=0')).Items).toBeDefined();
  }, 60_000);
});
