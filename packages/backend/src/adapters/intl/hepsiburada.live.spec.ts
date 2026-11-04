import * as adapter from './hepsiburada.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Hepsiburada Marketplace merchant API (developers.hepsiburada.com). Orders and claims are on
 * oms-external.hepsiburada.com, listings on listing-external.hepsiburada.com; the documented
 * test hosts add -sit. Built from the documentation: no call has been run against a real account.
 * Live part (reads only):
 *   HEPSIBURADA_MERCHANT_ID=... HEPSIBURADA_INTEGRATION_SECRET=... RUN_HEPSIBURADA_LIVE=1 \
 *     npx jest src/adapters/intl/hepsiburada
 */

type Tool = {
  name: string;
  description: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: { transform?: unknown };
};
const a = adapter as unknown as {
  instructions: string;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const pathParams = (t: Tool) =>
  [...t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
const LISTINGS = 'https://listing-external.hepsiburada.com';
const MERCHANT = '{{HEPSIBURADA_MERCHANT_ID}}';

describe('hepsiburada adapter: static spec conformance', () => {
  it('uses Basic auth with the merchant ID and secret, and sends the required User-Agent', () => {
    expect(a.connector.baseUrl).toBe('https://oms-external.hepsiburada.com');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: MERCHANT, password: '{{HEPSIBURADA_INTEGRATION_SECRET}}' });
    expect(a.connector.headers['User-Agent']).toBe(`${MERCHANT} - AnythingMCP`);
  });

  it('maps the documented read endpoints', () => {
    const routes = Object.fromEntries(a.tools.map((t) => [t.name, `${t.endpointMapping.method} ${t.endpointMapping.path}`]));
    expect(routes).toEqual({
      hepsiburada_list_orders: `GET /orders/merchantid/${MERCHANT}`,
      hepsiburada_get_order: `GET /orders/merchantid/${MERCHANT}/ordernumber/{orderNumber}`,
      hepsiburada_list_listings: `GET ${LISTINGS}/listings/merchantid/${MERCHANT}`,
      hepsiburada_list_claims: `GET /claims/merchantId/${MERCHANT}`,
      hepsiburada_list_claims_by_status: `GET /claims/merchantId/${MERCHANT}/status/{status}`,
    });
  });

  it('sends the hyphenated listing filters under their documented names', () => {
    const q = tool('hepsiburada_list_listings').endpointMapping.queryParams;
    expect(q?.['salable-listings']).toBe('$salableListings');
    expect(q?.['notsalable-listings']).toBe('$notSalableListings');
  });

  it('every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('hepsiburada_')).toBe(true);
      const sent = [...pathParams(t), ...Object.values(t.endpointMapping.queryParams ?? {}).map((v) => v.slice(1))].sort();
      expect(`${t.name}:${sent}`).toBe(`${t.name}:${Object.keys(t.parameters?.properties ?? {}).sort()}`);
      for (const p of pathParams(t)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('sends offset and limit together by default on every list tool', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.queryParams)) {
      const props = t.parameters?.properties as Record<string, { default?: number }>;
      expect(typeof props.offset.default).toBe('number');
      expect(typeof props.limit.default).toBe('number');
    }
  });

  it('removes identity and card fields from order responses and keeps the rest', () => {
    const line = {
      id: 'line-1',
      orderNumber: '0116431',
      creditCardHolderName: 'A Customer',
      invoice: { turkishIdentityNumber: '11111111111', taxNumber: '222', taxOffice: 'Sisli' },
    };
    const kept = { id: 'line-1', orderNumber: '0116431', invoice: { taxOffice: 'Sisli' } };
    const list = applyResponseTransform({ totalCount: 1, items: [line] }, tool('hepsiburada_list_orders').responseMapping as never).value;
    expect(list).toEqual({ totalCount: 1, items: [kept] });
    const one = applyResponseTransform({ items: [line] }, tool('hepsiburada_get_order').responseMapping as never).value;
    expect(one).toEqual({ items: [kept] });
  });

  it('marks every tool read-only, probes with a read and documents every tool', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.responseMapping).toBeDefined();
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    }
    expect(a.probe.tool).toBe('hepsiburada_list_listings');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
  });
});

const env = process.env;
const live =
  env.RUN_HEPSIBURADA_LIVE === '1' && env.HEPSIBURADA_MERCHANT_ID && env.HEPSIBURADA_INTEGRATION_SECRET
    ? describe
    : describe.skip;
live('hepsiburada adapter: live (read-only)', () => {
  const merchant = env.HEPSIBURADA_MERCHANT_ID ?? '';
  const headers = {
    Authorization: `Basic ${Buffer.from(`${merchant}:${env.HEPSIBURADA_INTEGRATION_SECRET ?? ''}`).toString('base64')}`,
    'User-Agent': `${merchant} - AnythingMCP`,
    Accept: 'application/json',
  };
  const expectOk = async (url: string) => {
    const res = await fetch(url, { headers });
    expect(res.status).toBe(200);
  };
  it('reads orders, listings and claims', async () => {
    await expectOk(`${a.connector.baseUrl}/orders/merchantid/${merchant}?offset=0&limit=1`);
    await expectOk(`${LISTINGS}/listings/merchantid/${merchant}?offset=0&limit=1`);
    await expectOk(`${a.connector.baseUrl}/claims/merchantId/${merchant}?offset=0&limit=1`);
    await expectOk(`${a.connector.baseUrl}/claims/merchantId/${merchant}/status/awaitingaction?offset=0&limit=1`);
  }, 60_000);
});
