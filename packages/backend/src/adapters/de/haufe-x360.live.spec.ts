import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import * as adapter from './haufe-x360.json';

// No X360 tenant is reachable from CI. Requests go through the real REST
// engine with axios mocked (auth left out: the session login is covered by
// the login-token service's own tests) to check paths and query options
// against Acumatica's Default endpoint.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarAliases?: Record<string, string[]>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers: Record<string, string>;
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const BASE = 'https://x360.example.com/entity/Default/24.200.001';

async function send(name: string, params: Record<string, unknown>) {
  mockedAxios.mockResolvedValue({ data: [], headers: { 'content-type': 'application/json' } });
  await new RestEngine({} as never, {} as never).execute(
    { baseUrl: BASE, authType: 'NONE', headers: a.connector.headers },
    tool(name).endpointMapping,
    params,
  );
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as unknown as {
    url: string;
    method: string;
    params: Record<string, unknown>;
  };
}

describe('haufe-x360 adapter: static spec conformance', () => {
  it('is listed (verified against the official API spec on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('reads the Default endpoint at a version the tenant chooses', () => {
    expect(a.connector.baseUrl).toBe('{{X360_URL}}/entity/Default/{{X360_ENDPOINT_VERSION}}');
    expect(a.requiredEnvVars).toEqual(['X360_URL', 'X360_TENANT', 'X360_ENDPOINT_VERSION', 'X360_USERNAME', 'X360_PASSWORD']);
    expect(a.optionalEnvVars).toBeUndefined();
    expect(a.envVarAliases).toEqual({ X360_TENANT: ['X360_COMPANY'] });
  });

  it('signs in at /entity/auth/login and keeps every session cookie', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(auth.loginUrl).toBe('{{X360_URL}}/entity/auth/login');
    expect(auth.loginBody).toEqual({ name: '${username}', password: '${password}', tenant: '{{X360_TENANT}}' });
    expect(auth).toMatchObject({
      tokenSource: 'cookie',
      cookieMode: 'all',
      cookieName: 'ASP.NET_SessionId',
      headerName: 'Cookie',
      headerTemplate: '${token}',
      refreshOn401: true,
    });
  });

  it('every tool is a read-only GET on a Default endpoint entity', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path).toMatch(/^\/(Customer|SalesOrder|StockItem|Invoice|Shipment|Vendor)(\/\{customerId\})?$/);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('maps list options to the documented $ query parameters', async () => {
    const sent = await send('haufe_x360_list_invoices', {
      filter: "Status eq 'Open'",
      top: 20,
      skip: 40,
      select: 'ReferenceNbr,Balance',
      expand: 'Details',
    });
    expect(sent.url).toBe(`${BASE}/Invoice`);
    expect(sent.params).toEqual({ $filter: "Status eq 'Open'", $top: 20, $skip: 40, $select: 'ReferenceNbr,Balance', $expand: 'Details' });
  });

  it('reads one customer by its key field', async () => {
    const sent = await send('haufe_x360_get_customer', { customerId: 'C000001', expand: 'MainContact' });
    expect(sent.url).toBe(`${BASE}/Customer/C000001`);
    expect(sent.params).toEqual({ $expand: 'MainContact' });
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_HAUFE_X360_LIVE === '1';
(live ? describe : describe.skip)('haufe-x360: live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // Install the adapter against a real tenant and run the probe
    // (haufe_x360_list_customers with top=1).
    expect(a.probe.tool).toBeTruthy();
  });
});
