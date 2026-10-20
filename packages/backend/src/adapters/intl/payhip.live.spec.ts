import * as adapter from './payhip.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

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
 * Payhip API v2. Static: no customer key exists. Diffed against
 * payhip.com/api-reference (coupons, license keys): payhip-api-key for
 * coupons, product-secret-key for license keys, form-encoded bodies, PUT for
 * license changes. Fake-key probes from the Cloud backend (20 Oct 2026):
 * license/verify answers 401 authentication_fail directly; /coupons gets a
 * Cloudflare challenge from the datacenter IP and 401 authentication_fail
 * through the Cloud's outbound proxy, hence useProxy on the coupon tools.
 */
const a = adapter as unknown as Adapter;
const KEY = ['phk', 'fake', '0001'].join('_');
const SECRET = ['pss', 'fake', '0002'].join('_');
const { tool, call, sent } = harness(a, { PAYHIP_API_KEY: KEY, PAYHIP_PRODUCT_SECRET_KEY: SECRET });
const B = 'https://payhip.com/api/v2';

describe('payhip adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset().mockResolvedValue({ status: 200, data: { data: {} }, headers: {} }));

  it('lists coupons with the account key, through the proxy', async () => {
    await call('payhip_list_coupons', { offset: 50 });
    expect(sent().url).toBe(`${B}/coupons`);
    expect(sent().headers['payhip-api-key']).toBe(KEY);
    expect(sent().params).toEqual({ limit: 50, offset: 50 });
    expect(a.tools.filter((t) => t.useProxy).map((t) => t.name)).toEqual(['payhip_list_coupons', 'payhip_get_coupon', 'payhip_create_coupon']);
  });

  it('creates a coupon as a form, installed off', async () => {
    const t = tool('payhip_create_coupon');
    expect(t.enabled).toBe(false);
    await call('payhip_create_coupon', { code: 'AUTUMN20', coupon_type: 'multi', percent_off: 20 });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe(`${B}/coupons`);
    expect(String(sent().data)).toBe('code=AUTUMN20&coupon_type=multi&percent_off=20');
  });

  it('verifies a license key with the product secret key', async () => {
    await call('payhip_verify_license', { license_key: '9Q2KX-ZP7RM' });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe(`${B}/license/verify`);
    expect(sent().params).toEqual({ license_key: '9Q2KX-ZP7RM' });
    expect(sent().headers['product-secret-key']).toBe(SECRET);
  });

  it('changes license keys with PUT and a form body, all installed off', async () => {
    const paths: Record<string, string> = {
      payhip_disable_license: '/license/disable',
      payhip_enable_license: '/license/enable',
      payhip_increase_license_usage: '/license/usage',
      payhip_decrease_license_usage: '/license/decrease',
    };
    for (const [name, path] of Object.entries(paths)) {
      expect(tool(name).enabled).toBe(false);
      mockedAxios.mockClear();
      await call(name, { license_key: 'K-1' });
      expect(`${sent().method} ${sent().url} ${sent().data}`).toBe(`PUT ${B}${path} license_key=K-1`);
      expect(sent().headers['product-secret-key']).toBe(SECRET);
    }
    expect(a.tools.filter((t) => t.enabled !== false).map((t) => t.name)).toEqual(['payhip_list_coupons', 'payhip_get_coupon', 'payhip_verify_license']);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

