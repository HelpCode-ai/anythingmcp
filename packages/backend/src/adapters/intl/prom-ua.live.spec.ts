import * as adapter from './prom-ua.json';

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, string>;
  };
  annotations?: Record<string, boolean>;
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: { token: string } };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Prom.ua adapter — static contract', () => {
  it('uses the seller API with the cabinet token as a bearer token', () => {
    expect(a.requiredEnvVars).toEqual(['PROM_UA_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://my.prom.ua/api/v1');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{PROM_UA_API_TOKEN}}');
    expect(a.probe).toEqual({ tool: 'prom_ua_list_orders', params: { limit: 1 } });
  });

  it('maps the documented paths, all reads except one status change', () => {
    const routes = Object.fromEntries(
      a.tools.map((tool) => [tool.name, `${tool.endpointMapping.method} ${tool.endpointMapping.path}`]),
    );
    expect(routes).toEqual({
      prom_ua_list_orders: 'GET /orders/list',
      prom_ua_get_order: 'GET /orders/{id}',
      prom_ua_list_order_statuses: 'GET /order_status_options/list',
      prom_ua_set_order_status: 'POST /orders/set_status',
      prom_ua_list_products: 'GET /products/list',
      prom_ua_get_product: 'GET /products/{id}',
      prom_ua_get_product_by_external_id: 'GET /products/by_external_id/{external_id}',
      prom_ua_list_groups: 'GET /groups/list',
      prom_ua_list_clients: 'GET /clients/list',
      prom_ua_get_client: 'GET /clients/{id}',
      prom_ua_list_messages: 'GET /messages/list',
    });
    expect(a.tools.every((tool) => tool.name.startsWith('prom_ua_'))).toBe(true);
  });

  it('pages lists with limit and last_id', () => {
    for (const name of ['prom_ua_list_orders', 'prom_ua_list_products', 'prom_ua_list_groups', 'prom_ua_list_clients', 'prom_ua_list_messages']) {
      expect(byName[name].endpointMapping.queryParams).toMatchObject({ limit: '$limit', last_id: '$last_id' });
    }
  });

  it('marks the status change as a destructive write that needs confirmation', () => {
    const tool = byName.prom_ua_set_order_status;
    expect(tool.parameters.required).toEqual(['ids']);
    expect(tool.endpointMapping.bodyMapping).toEqual({
      ids: '$ids',
      status: '$status',
      cancellation_reason: '$cancellation_reason',
      cancellation_text: '$cancellation_text',
      custom_status_id: '$custom_status_id',
    });
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect((tool as unknown as { description: string }).description).toMatch(/confirmation/);
  });
});

// Opt-in: RUN_PROM_UA_LIVE=1. Without PROM_UA_API_TOKEN it only checks that a wrong token gets 401;
// with a token it lists one order and the status options (read-only).
const live = process.env.RUN_PROM_UA_LIVE === '1';
(live ? describe : describe.skip)('Prom.ua — live read-only smoke test', () => {
  const base = 'https://my.prom.ua/api/v1';

  it('answers a wrong token with 401', async () => {
    const response = await fetch(base + '/orders/list?limit=1', {
      headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000' },
    });
    expect(response.status).toBe(401);
  }, 30000);

  const token = process.env.PROM_UA_API_TOKEN;
  (token ? it : it.skip).each(['/orders/list?limit=1', '/order_status_options/list'])('reads %s', async (path) => {
    const response = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
    expect(response.status).toBe(200);
  }, 30000);
});
