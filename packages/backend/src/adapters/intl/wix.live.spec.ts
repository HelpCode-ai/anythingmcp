import * as adapter from './wix.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static checks always run. The live block runs only with a real API key
 * and site ID and calls read-only tools through the real RestEngine:
 *   WIX_API_KEY=xxx WIX_SITE_ID=uuid npx jest src/adapters/intl/wix.live.spec.ts
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string; extraHeaders: Record<string, string> };
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: Mapping;
    annotations?: Record<string, boolean>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string' && v.startsWith('$')) out.add(v.slice(1));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) refs(x, out);
};

describe('wix adapter: static spec conformance', () => {
  it('ships unlisted until verified against a real site', () => {
    expect(a.unlisted).toBe(true);
  });

  it('sends the API key bare in Authorization plus the wix-site-id header', () => {
    expect(a.connector.baseUrl).toBe('https://www.wixapis.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: '{{WIX_API_KEY}}',
      extraHeaders: { 'wix-site-id': '{{WIX_SITE_ID}}' },
    });
    expect(a.requiredEnvVars).toEqual(['WIX_API_KEY', 'WIX_SITE_ID']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('never sends wix-account-id next to wix-site-id', () => {
    expect(JSON.stringify(a)).not.toMatch(/wix-account-id"\s*:/);
  });

  it('validates the site ID as a UUID', () => {
    const re = new RegExp(a.envVarMeta.WIX_SITE_ID.pattern as string);
    expect(re.test('1a2b3c4d-1234-5678-9abc-1234567890ab')).toBe(true);
    expect(re.test('my-site')).toBe(false);
  });

  it('probes with the site properties, which need no parameters', () => {
    expect(a.probe.tool).toBe('wix_get_site_properties');
    expect(tool('wix_get_site_properties').endpointMapping).toEqual({ method: 'GET', path: '/site-properties/v4/properties' });
    expect(a.connector.healthcheckPath).toBe('/site-properties/v4/properties');
  });

  it('has no DELETE tool and every path is relative to wixapis.com', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(t.endpointMapping.path.startsWith('/')).toBe(true);
    }
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      refs(m.queryParams, used);
      refs(m.bodyMapping, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('POST query and search tools are marked read-only', () => {
    const reads = a.tools.filter((t) => t.endpointMapping.method === 'POST' && t.name !== 'wix_create_contact');
    expect(reads.map((t) => t.name).sort()).toEqual([
      'wix_query_blog_posts',
      'wix_query_booking_services',
      'wix_query_bookings',
      'wix_query_contacts',
      'wix_query_products_v1',
      'wix_search_orders',
      'wix_search_products',
    ]);
    for (const t of reads) expect(t.annotations).toEqual({ readOnlyHint: true });
    expect(tool('wix_create_contact').annotations).toBeUndefined();
  });

  it('wraps the query in the envelope each API expects', () => {
    expect(tool('wix_search_orders').endpointMapping.bodyMapping).toEqual({
      search: { filter: '$filter', sort: '$sort', cursorPaging: { limit: '$limit', cursor: '$cursor' } },
    });
    expect(Object.keys(tool('wix_search_products').endpointMapping.bodyMapping ?? {})).toEqual(['fields', 'search']);
    expect(Object.keys(tool('wix_query_contacts').endpointMapping.bodyMapping ?? {})).toEqual(['query']);
  });
});

const KEY = process.env.WIX_API_KEY;
const SITE = process.env.WIX_SITE_ID;
const live = KEY && SITE ? describe : describe.skip;

live('wix adapter: live read-only calls', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'API_KEY',
        authConfig: { headerName: 'Authorization', apiKey: KEY as string, extraHeaders: { 'wix-site-id': SITE as string } },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );

  it('reads the site properties and published URLs', async () => {
    const props = await run('wix_get_site_properties');
    expect(props.properties).toBeDefined();
    const urls = await run('wix_list_site_urls');
    expect(Array.isArray(urls.urls ?? [])).toBe(true);
  }, 30000);

  it('reads the catalog version and products of that version', async () => {
    const v = await run('wix_get_catalog_version');
    expect(['V1_CATALOG', 'V3_CATALOG', 'STORES_NOT_INSTALLED']).toContain(v.catalogVersion);
    if (v.catalogVersion === 'V3_CATALOG') {
      const res = await run('wix_search_products', { limit: 2 });
      expect(Array.isArray(res.products ?? [])).toBe(true);
    } else if (v.catalogVersion === 'V1_CATALOG') {
      const res = await run('wix_query_products_v1', { limit: 2 });
      expect(Array.isArray(res.products ?? [])).toBe(true);
    }
  }, 30000);

  it('searches orders and queries contacts', async () => {
    const orders = await run('wix_search_orders', { limit: 1 });
    expect(Array.isArray(orders.orders ?? [])).toBe(true);
    const contacts = await run('wix_query_contacts', { limit: 1, fieldsets: ['BASIC'] });
    expect(Array.isArray(contacts.contacts ?? [])).toBe(true);
  }, 30000);
});
