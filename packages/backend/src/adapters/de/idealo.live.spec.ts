import * as adapter from './idealo.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: Record<string, any>;
  annotations?: Record<string, unknown>;
  useProxy?: boolean;
};
type Adapter = {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers?: Record<string, string> };
  tools: Tool[];
};
const harness = (a: Adapter, env: Record<string, string>) => {
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };
  // Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
  const call = (name: string, params: Record<string, unknown>, authType = a.connector.authType) => {
    const { config, endpointMapping } = interpolateConnectorConfig(
      { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
      tool(name).endpointMapping as never,
      env,
    );
    return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      { baseUrl: config.baseUrl, authType, authConfig: interpolateDeep({ ...a.connector.authConfig }, env), headers: config.headers },
      endpointMapping as never,
      { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
    ) as Promise<any>;
  };
  const sent = (i = 0) => mockedAxios.mock.calls[i][0];
  return { tool, call, sent };
};


/**
 * idealo Partner Web Service 2.0 (offers). Static: no customer key exists.
 * Diffed against idealo.github.io/partner-web-service/docs/v2 (updated
 * 19 Oct 2026): host import.idealo.com, /shop/{shopId}/offer/{sku} with GET,
 * PUT, PATCH and DELETE, token by client_credentials with HTTP Basic at
 * api.idealo.com/mer/businessaccount/api/v1/oauth/token. Fake-credential
 * probes from the Cloud backend (20 Oct 2026): the token endpoint answers
 * 401 for an unknown client UUID, PWS 401 for a fake bearer. The order API
 * (Direktkauf) was shut down in 2023 and is not part of this adapter.
 */
const a = adapter as unknown as Adapter;
const ENV = { IDEALO_CLIENT_ID: '0f8fad5b-d9cb-469f-a165-70867728950e', IDEALO_CLIENT_SECRET: ['s', 'e', 'c'].join(''), IDEALO_SHOP_ID: '123456' };
const { tool, call, sent } = harness(a, ENV);
const OFFER = 'https://import.idealo.com/shop/123456/offer';

describe('idealo adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset().mockResolvedValue({ status: 200, data: {}, headers: {} }));

  it('gets its token by client credentials with HTTP Basic, no browser sign-in', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{IDEALO_CLIENT_ID}}',
      clientSecret: '{{IDEALO_CLIENT_SECRET}}',
      tokenUrl: 'https://api.idealo.com/mer/businessaccount/api/v1/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(needsBrowserAuthorization(a as never)).toBe(false);
    expect(new RegExp(a.envVarMeta.IDEALO_CLIENT_ID.pattern!).test(ENV.IDEALO_CLIENT_ID)).toBe(true);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'IDEALO_CLIENT_SECRET')!.secret).toBe(true);
  });

  it('reads an offer by SKU in the configured shop, SKU encoded', async () => {
    await call('idealo_get_offer', { sku: 'ABC-1.2_x' }, 'NONE');
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${OFFER}/ABC-1.2_x`);
    const re = new RegExp(tool('idealo_get_offer').parameters.properties!.sku.pattern);
    for (const bad of ['a b', 'a/b', '../x', 'a;b']) expect(re.test(bad)).toBe(false);
  });

  it('writes with PUT, PATCH and DELETE on the same path, all installed off', async () => {
    const offer = { sku: 'ABC-1', title: 'T', price: '1.00', url: 'https://shop.example/a', deliveryCosts: { DHL: '0.00' }, paymentCosts: { PAYPAL: '0.00' } };
    await call('idealo_upsert_offer', { sku: 'ABC-1', offer }, 'NONE');
    expect(`${sent().method} ${sent().url}`).toBe(`PUT ${OFFER}/ABC-1`);
    expect(sent().data).toEqual(offer);
    mockedAxios.mockClear();
    await call('idealo_update_offer', { sku: 'ABC-1', fields: { price: '0.99' } }, 'NONE');
    expect(`${sent().method} ${sent().url}`).toBe(`PATCH ${OFFER}/ABC-1`);
    expect(sent().data).toEqual({ price: '0.99' });
    mockedAxios.mockClear();
    await call('idealo_delete_offer', { sku: 'ABC-1' }, 'NONE');
    expect(`${sent().method} ${sent().url}`).toBe(`DELETE ${OFFER}/ABC-1`);
    expect(a.tools.filter((t) => t.enabled !== false).map((t) => t.name)).toEqual(['idealo_get_offer']);
    // Deleting every offer at once is not offered.
    expect(a.tools.some((t) => /\/offer$/.test(t.endpointMapping.path))).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

