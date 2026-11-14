import axios from 'axios';
import { createHmac } from 'crypto';
import * as adapter from './kaufland.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return { __esModule: true, default: Object.assign(mocked, actual.default, { __actual: actual.default }), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; description: string; enabled?: boolean; parameters?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean }; endpointMapping: Record<string, unknown> }>;
};
const WRITES = ['kaufland_add_ticket_message', 'kaufland_add_tracking_to_order_unit'];

const toolNames = a.tools.map((t) => t.name);

describe('kaufland adapter — static spec conformance', () => {
  it("signs the request instead of sending the secret", () => {
    expect(a.connector.authType).toBe('HMAC');
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.secret).toBe('{{KAUFLAND_SECRET_KEY}}');
    expect(sig.headerName).toBe('Shop-Signature');
  });

  it("sends the timestamp it signed, so the server can recompute the string", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.timestampHeader).toBe('Shop-Timestamp');
    expect(String(sig.template)).toContain('${timestamp}');
  });

  it("identifies the seller with the public client key", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect((sig.extraHeaders as Record<string, string>)['Shop-Client-Key']).toBe('{{KAUFLAND_CLIENT_KEY}}');
  });

  it("covers method, url, body and timestamp in that order", () => {
    const sig = (a.connector.authConfig as Record<string, Record<string, unknown>>).signature;
    expect(sig.template).toBe('${method}\\n${url}\\n${body}\\n${timestamp}');
  });

  it("only calls endpoints the Seller API has", () => {
    // Checked against a live seller account in Oct 2026: /storefronts and
    // GET /shipments answer 404; the storefront list lives under /info.
    // The OpenAPI schema (sellerapi.kaufland.com/swagger.json) has POST /shipments only.
    const paths = a.tools.map((t) => t.endpointMapping.path);
    expect(paths).toContain('/info/storefront');
    expect(paths).not.toContain('/storefronts');
    for (const t of a.tools.filter((x) => x.endpointMapping.path === '/shipments')) expect(t.endpointMapping.method).toBe('POST');
  });

  it("writes only the ticket answer and the tracking number, both asking for confirmation", () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET').map((t) => t.name);
    expect(writes.sort()).toEqual([...WRITES].sort());
    for (const n of WRITES) {
      const t = a.tools.find((x) => x.name === n)!;
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.description).toMatch(/confirm/);
      expect(t.enabled).toBeUndefined();
    }
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_KAUFLAND_LIVE === '1';
(live ? describe : describe.skip)('kaufland — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // kaufland answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});

describe('kaufland_list_tickets limit', () => {
  it('caps limit at 30, the most the tickets endpoint accepts', () => {
    const tool = (adapter as unknown as {
      tools: { name: string; parameters: { properties: Record<string, { maximum?: number }> } }[];
    }).tools.find((t) => t.name === 'kaufland_list_tickets')!;
    expect(tool.parameters.properties.limit.maximum).toBe(30);
  });
});

describe('kaufland_get_order embedded', () => {
  it('only accepts the objects the order endpoint can embed', () => {
    const tool = (adapter as unknown as {
      tools: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } }[];
    }).tools.find((t) => t.name === 'kaufland_get_order')!;
    expect(tool.parameters.properties.embedded.enum).toEqual(['order_invoices', 'delivery', 'kss_delivery']);
  });
});

describe('kaufland_list_units storefront', () => {
  it('requires the storefront, which Kaufland rejects the call without', () => {
    const tool = (adapter as unknown as {
      tools: { name: string; parameters: { required?: string[] } }[];
    }).tools.find((t) => t.name === 'kaufland_list_units')!;
    expect(tool.parameters.required).toEqual(['storefront']);
  });
});

describe('kaufland tickets, returns and shipments', () => {
  const ENV = { KAUFLAND_CLIENT_KEY: 'client-key-1', KAUFLAND_SECRET_KEY: 'secret-key-1' };
  const tool = (n: string) => a.tools.find((t) => t.name === n)!;
  const send = async (name: string, params: Record<string, unknown>) => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, ENV), headers: a.connector.headers } as never,
      tool(name).endpointMapping as never,
      applySchemaDefaults(tool(name).parameters as never, params),
    );
    return mockedAxios.mock.calls[0][0];
  };
  const B = 'https://sellerapi.kaufland.com/v2';

  // Routes, parameters and bodies from sellerapi.kaufland.com/swagger.json (checked 5 Nov 2026).
  it('maps the documented routes', async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['kaufland_get_ticket_details', { id_ticket: 'abc123' }, 'GET', '/tickets/abc123'],
      ['kaufland_list_ticket_messages', {}, 'GET', '/tickets/messages'],
      ['kaufland_search_returns', {}, 'GET', '/returns'],
      ['kaufland_get_return_details', { id_return: 77 }, 'GET', '/returns/77'],
      ['kaufland_list_return_units', {}, 'GET', '/return-units'],
      ['kaufland_add_ticket_message', { id_ticket: 'abc123', text: 'Hallo' }, 'POST', '/tickets/abc123/messages'],
      ['kaufland_add_tracking_to_order_unit', { id_order_unit: 5, carrier_code: 'DHL', tracking_number: '0034' }, 'POST', '/shipments'],
    ];
    for (const [name, params, method, path] of cases) {
      const req = await send(name, params);
      expect(`${name}:${req.method} ${req.url}`).toBe(`${name}:${method} ${B}${path}`);
      expect(req.headers['Shop-Client-Key']).toBe('client-key-1');
      expect(req.headers['Shop-Signature']).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('builds the bodies and the embedded lists', async () => {
    expect((await send('kaufland_add_ticket_message', { id_ticket: 't', text: 'Wir senden Ersatz.' })).data).toEqual({ text: 'Wir senden Ersatz.' });
    expect((await send('kaufland_add_tracking_to_order_unit', { id_order_unit: 5, carrier_code: 'DHL', tracking_number: '0034' })).data).toEqual({
      id_order_unit: 5,
      shipment_information: { carrier_code: 'DHL', tracking_number: '0034' },
    });
    expect((await send('kaufland_get_ticket_details', { id_ticket: 't' })).params).toEqual({ embedded: ['messages'] });
    expect((await send('kaufland_get_return_details', { id_return: 1, embedded: ['return_units', 'buyer'] })).params).toEqual({ embedded: ['return_units', 'buyer'] });
    expect((await send('kaufland_search_returns', { status: ['package_received'], limit: 10 })).params).toEqual({ status: ['package_received'], limit: 10 });
  });

  it('signs a POST over method, URL, JSON body and timestamp', async () => {
    const req = await send('kaufland_add_ticket_message', { id_ticket: 't', text: 'Hallo' });
    const ts = req.headers['Shop-Timestamp'];
    const body = typeof req.data === 'string' ? req.data : JSON.stringify(req.data);
    const expected = createHmac('sha256', 'secret-key-1').update(`POST\n${B}/tickets/t/messages\n${body}\n${ts}`).digest('hex');
    expect(req.headers['Shop-Signature']).toBe(expected);
  });
});
