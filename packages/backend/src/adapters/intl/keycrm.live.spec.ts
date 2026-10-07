import * as adapter from './keycrm.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { default?: unknown; maximum?: number }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { token: string } };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('KeyCRM adapter — static contract', () => {
  it('calls the OpenAPI v1 with the API key as a bearer token', () => {
    expect(a.slug).toBe('keycrm');
    expect(a.region).toBe('intl');
    expect(a.requiredEnvVars).toEqual(['KEYCRM_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://openapi.keycrm.app/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{KEYCRM_API_KEY}}');
    expect(a.envVarMeta.KEYCRM_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.KEYCRM_API_KEY.pattern!).test('Bearer abc')).toBe(false);
    expect(a.probe.tool).toBe('keycrm_list_order_statuses');
  });

  it('offers thirteen reads and one confirm-first create', () => {
    expect(a.tools).toHaveLength(14);
    expect(a.tools.every((tool) => tool.name.startsWith('keycrm_'))).toBe(true);
    const writes = a.tools.filter((tool) => tool.endpointMapping.method !== 'GET');
    expect(writes.map((tool) => [tool.name, tool.endpointMapping.method, tool.endpointMapping.path])).toEqual([
      ['keycrm_create_order', 'POST', '/order'],
    ]);
    expect(writes[0].description).toMatch(/confirm/i);
  });

  it('pages with page + limit (max 50) and filters with filter[field]', () => {
    for (const tool of a.tools.filter((t) => t.endpointMapping.method === 'GET' && t.parameters.properties?.page)) {
      expect(tool.endpointMapping.queryParams).toMatchObject({ limit: '$limit', page: '$page' });
      expect(tool.parameters.properties!.limit.maximum).toBe(50);
    }
    expect(byName.keycrm_list_orders.endpointMapping.queryParams).toMatchObject({
      'filter[status_id]': '$status_id',
      'filter[buyer_phone]': '$buyer_phone',
      'filter[created_between]': '$created_between',
      include: '$include',
    });
    expect(byName.keycrm_list_stocks.endpointMapping).toMatchObject({ path: '/offers/stocks', queryParams: { 'filter[details]': '$details' } });
    expect(byName.keycrm_list_pipeline_statuses.endpointMapping.path).toBe('/pipelines/{pipeline_id}/statuses');
    expect(a.instructions).toContain('next_page_url');
    expect(a.instructions).toContain('20 requests per minute');
  });

  it('sends the documented order body: source_id and a buyer object', () => {
    expect(byName.keycrm_create_order.parameters.required).toEqual(['source_id', 'buyer_full_name']);
    expect(byName.keycrm_create_order.endpointMapping.bodyMapping).toMatchObject({
      source_id: '$source_id',
      buyer: { full_name: '$buyer_full_name', phone: '$buyer_phone', email: '$buyer_email' },
      products: '$products',
    });
  });

  it('keeps the instructions within the house limits', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1000);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('**Getting credentials**');
    expect(a.instructions).toContain('**Cloud reachability**');
  });
});

// Opt-in: run with RUN_KEYCRM_LIVE=1 and KEYCRM_API_KEY. Mind the 20 requests per minute limit.
const live = process.env.RUN_KEYCRM_LIVE === '1';
(live ? describe : describe.skip)('KeyCRM — live read-only smoke test', () => {
  it.each(['/order/status', '/order?limit=1&include=buyer,status'])('reads %s as a paginated list', async (path) => {
    const key = process.env.KEYCRM_API_KEY;
    if (!key) throw new Error('Set KEYCRM_API_KEY for RUN_KEYCRM_LIVE=1');
    const response = await fetch('https://openapi.keycrm.app/v1' + path, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.current_page).toBe('number');
  });
});
