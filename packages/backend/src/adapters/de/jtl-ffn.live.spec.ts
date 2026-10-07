import * as adapter from './jtl-ffn.json';
import { setupKind } from '../env-var-meta';

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, string>;
  };
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  icon: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    healthcheckPath: string;
    authConfig: Record<string, string>;
  };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));
const BASE = 'https://ffn2.api.jtl-software.com/api';

describe('JTL-FFN adapter — static contract', () => {
  it('authorizes with the JTL OAuth2 code flow and Basic client authentication', () => {
    expect(a.slug).toBe('jtl-ffn');
    expect(a.region).toBe('de');
    expect(a.icon).toBe('jtl-ffn');
    expect(a.requiredEnvVars).toEqual(['JTL_FFN_CLIENT_ID', 'JTL_FFN_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{JTL_FFN_CLIENT_ID}}',
      clientSecret: '{{JTL_FFN_CLIENT_SECRET}}',
      authorizationUrl: 'https://oauth2.api.jtl-software.com/authorize',
      tokenUrl: 'https://oauth2.api.jtl-software.com/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'ffn.merchant.read ffn.merchant.write',
    });
    expect(setupKind(a as never)).toBe('oauth_browser');
    expect(a.connector.healthcheckPath).toBe('/v1/users/current');
    expect(a.probe.tool).toBe('jtl_ffn_get_current_user');
  });

  it('prefixes every tool and keeps writes to two switched-off tools', () => {
    expect(a.tools.every((t) => t.name.startsWith('jtl_ffn_'))).toBe(true);
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => [t.name, t.endpointMapping.method, t.enabled])).toEqual([
      ['jtl_ffn_create_outbound', 'POST', false],
      ['jtl_ffn_cancel_outbound', 'PUT', false],
    ]);
    expect(a.tools.filter((t) => t.endpointMapping.method === 'GET').every((t) => t.enabled === undefined)).toBe(true);
  });

  it('maps paging and filters to the API query options', () => {
    expect(byName.jtl_ffn_list_outbounds.endpointMapping.queryParams).toEqual({
      $filter: '$filter',
      $orderBy: '$order_by',
      $top: '$limit',
      $skip: '$offset',
    });
    expect(byName.jtl_ffn_list_outbound_changes.endpointMapping.queryParams).toEqual({
      fromDate: '$from_date',
      toDate: '$to_date',
      page: '$page',
    });
  });

  it('checks the jfsku format before calling', () => {
    const pattern = new RegExp(byName.jtl_ffn_get_product.parameters.properties!.jfsku.pattern!);
    expect(pattern.test('MERC01PRDCT')).toBe(true);
    expect(pattern.test('ABC-1')).toBe(false);
    expect(pattern.test('MERC02PRDCT')).toBe(false);
  });

  it('sends the documented create and cancel bodies', () => {
    expect(byName.jtl_ffn_create_outbound.parameters.required).toEqual([
      'merchant_outbound_number',
      'warehouse_id',
      'currency',
      'shipping_address',
      'items',
    ]);
    expect(byName.jtl_ffn_create_outbound.endpointMapping).toMatchObject({
      path: '/v1/merchant/outbounds',
      bodyMapping: expect.objectContaining({
        merchantOutboundNumber: '$merchant_outbound_number',
        warehouseId: '$warehouse_id',
        shippingAddress: '$shipping_address',
        items: '$items',
      }),
    });
    expect(byName.jtl_ffn_cancel_outbound.endpointMapping.bodyMapping).toEqual({
      status: 'Canceled',
      cancelReason: '$cancel_reason',
      cancelReasonCode: '$cancel_reason_code',
    });
  });
});

// Opt-in: RUN_JTL_FFN_LIVE=1. Without a token it only checks that every path
// exists (the API answers 401 for a known route, 404 for an unknown one).
// With JTL_FFN_ACCESS_TOKEN (a merchant token, e.g. from the sandbox with
// JTL_FFN_API_URL=https://ffn-sbx.api.jtl-software.com/api) it also reads.
const live = process.env.RUN_JTL_FFN_LIVE === '1';
(live ? describe : describe.skip)('JTL-FFN — live smoke test', () => {
  const api = process.env.JTL_FFN_API_URL || BASE;
  const samples: Record<string, string> = {
    jfsku: 'MERC01PRDCT',
    warehouse_id: 'FULF04XX-12345-0001',
    outbound_id: 'SO-1001',
    inbound_id: 'PO-1001',
    return_id: 'R-1001',
  };
  const fill = (path: string) => path.replace(/\{(\w+)\}/g, (_, k) => samples[k]);

  it.each(a.tools.map((t) => [t.name, t.endpointMapping.method, t.endpointMapping.path]))(
    '%s (%s %s) is a known route',
    async (_name, method, path) => {
      const res = await fetch(api + fill(path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status).toBe(401);
    },
  );

  const token = process.env.JTL_FFN_ACCESS_TOKEN;
  (token ? it : it.skip).each(['/v1/users/current', '/v1/merchant/warehouses', '/v1/merchant/products?$top=1', '/v1/merchant/outbounds?$top=1'])(
    'reads %s with a merchant token',
    async (path) => {
      const res = await fetch(api + path, { headers: { Authorization: 'Bearer ' + token } });
      expect(res.status).toBe(200);
    },
  );
});
