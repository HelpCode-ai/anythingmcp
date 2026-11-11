import { CatalogResyncService, additiveQueryParams } from './catalog-resync.service';
import { getAdapter } from '../adapters/catalog';
import { hashInstructions } from '../adapters/catalog-fingerprint';

/**
 * A catalog fix that only adds an optional query parameter (WooCommerce
 * `_fields`, #1619) is safe: a call without the new argument sends the same
 * request as before, because the REST engine drops an absent `$arg` key.
 * Such a tool joins the safe class, so the boot-time reconciler applies it to
 * every installed connector. Anything else in the mapping stays structural.
 */
describe('additiveQueryParams', () => {
  const catalog = {
    endpointMapping: { method: 'GET', path: '/orders', queryParams: { page: '$page', _fields: '$_fields' } },
    parameters: { type: 'object', properties: { page: { type: 'integer' }, _fields: { type: 'string' } } },
  };
  const installed = { endpointMapping: { method: 'GET', path: '/orders', queryParams: { page: '$page' } } };

  it('names the optional query parameters the catalog only added', () => {
    expect(additiveQueryParams(catalog, installed)).toEqual(['_fields']);
  });

  it('accepts an installed mapping without any query parameters', () => {
    const c = { ...catalog, endpointMapping: { method: 'GET', path: '/orders', queryParams: { _fields: '$_fields' } } };
    expect(additiveQueryParams(c, { endpointMapping: { method: 'GET', path: '/orders' } })).toEqual(['_fields']);
  });

  it.each([
    ['a constant value (it would change every call)', { _fields: 'id,total' }],
    ['a template', { _fields: 'x${_fields}' }],
    ['an argument the parameters do not declare', { _fields: '$other' }],
  ])('refuses %s', (_label, added) => {
    const c = { ...catalog, endpointMapping: { ...catalog.endpointMapping, queryParams: { page: '$page', ...added } } };
    expect(additiveQueryParams(c, installed)).toBeNull();
  });

  it('refuses a required argument or one with a default (both change existing calls)', () => {
    const required = { ...catalog, parameters: { ...catalog.parameters, required: ['_fields'] } };
    expect(additiveQueryParams(required, installed)).toBeNull();
    const withDefault = {
      ...catalog,
      parameters: { type: 'object', properties: { page: { type: 'integer' }, _fields: { type: 'string', default: 'id' } } },
    };
    expect(additiveQueryParams(withDefault, installed)).toBeNull();
  });

  it('refuses when anything else differs: path, method, an existing key, a removed key, the body', () => {
    const variants = [
      { method: 'GET', path: '/orders/x', queryParams: { page: '$page' } },
      { method: 'POST', path: '/orders', queryParams: { page: '$page' } },
      { method: 'GET', path: '/orders', queryParams: { page: '$p' } },
      { method: 'GET', path: '/orders', queryParams: { page: '$page', mine: '$mine' } },
      { method: 'GET', path: '/orders', queryParams: { page: '$page' }, timeoutMs: 1000 },
    ];
    for (const endpointMapping of variants) {
      expect(additiveQueryParams(catalog, { endpointMapping })).toBeNull();
    }
  });

  it('is null when nothing was added', () => {
    expect(additiveQueryParams(catalog, { endpointMapping: catalog.endpointMapping })).toBeNull();
  });
});

describe('CatalogResyncService with added optional query parameters (WooCommerce modified_*)', () => {
  const SLUG = 'woocommerce';
  const LIST = 'woocommerce_list_orders';

  /** An installed connector from before these keys: list_orders without `modified_*`. */
  function setup(mutate?: (tools: any[]) => void) {
    const adapter = getAdapter(SLUG)!;
    const tools = adapter.tools.map((t: any, i: number) => ({
      id: `t${i}`,
      name: t.name,
      description: t.description,
      parameters: JSON.parse(JSON.stringify(t.parameters)),
      endpointMapping: JSON.parse(JSON.stringify(t.endpointMapping)),
      responseMapping: t.responseMapping ?? null,
      useProxy: t.useProxy === true,
      isEnabled: true,
      deprecatedAt: null,
    }));
    const list = tools.find((t: any) => t.name === LIST)!;
    for (const p of ['modified_after', 'modified_before', 'dates_are_gmt']) {
      delete list.endpointMapping.queryParams[p];
      delete list.parameters.properties[p];
    }
    list.description = 'old description';
    if (mutate) mutate(tools);
    const connector = {
      id: 'c-woo',
      name: adapter.connector.name,
      baseUrl: 'https://shop.example',
      instructions: adapter.instructions ?? null,
      config: { adapterSlug: SLUG, adapterVersion: 'old', instructionsBaseline: hashInstructions(adapter.instructions) },
      createdAt: new Date(),
      tools,
    };
    const toolUpdate = jest.fn().mockResolvedValue({});
    const connectorUpdate = jest.fn().mockResolvedValue({});
    const tx = {
      connector: { findUnique: jest.fn().mockResolvedValue(connector), update: connectorUpdate },
      mcpTool: { update: toolUpdate, create: jest.fn() },
    };
    const prisma = {
      connector: { findUnique: jest.fn().mockResolvedValue(connector) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    } as any;
    return { service: new CatalogResyncService(prisma), toolUpdate, connectorUpdate, adapter, tools };
  }

  it('classifies the tool as safe and the diff as safe class', async () => {
    const { service } = setup();
    const diff = await service.computeDiff('c-woo');
    expect(diff!.updated).toEqual([{ name: LIST, kind: 'safe', addedQueryParams: ['modified_after', 'modified_before', 'dates_are_gmt'] }]);
    expect(diff!.isSafeClass).toBe(true);
    expect(CatalogResyncService.hasSafeWork(diff!)).toBe(true);
  });

  it('safe mode writes the catalog mapping, parameters and description, and stamps the version', async () => {
    const { service, toolUpdate, connectorUpdate, adapter, tools } = setup();
    const { applied } = await service.resync('c-woo', 'safe');
    expect(applied).toBe(true);
    const listId = tools.find((t: any) => t.name === LIST)!.id;
    const call = toolUpdate.mock.calls.find((c) => c[0].where.id === listId)![0];
    const catalogList = (adapter.tools as any[]).find((t) => t.name === LIST);
    expect(call.data.endpointMapping).toEqual(catalogList.endpointMapping);
    expect(call.data.parameters.properties.modified_after).toBeDefined();
    expect(call.data.description).toBe(catalogList.description);
    // The operator's response mapping is never part of a safe update.
    expect(call.data.responseMapping).toBeUndefined();
    expect(connectorUpdate.mock.calls[0][0].data.config.adapterVersion).toBe(adapter.version);
  });

  it('keeps an operator-edited mapping structural and untouched in safe mode', async () => {
    const { service, toolUpdate, connectorUpdate, tools } = setup((all) => {
      const list = all.find((t: any) => t.name === LIST)!;
      list.endpointMapping.queryParams.status = 'processing';
    });
    const diff = await service.computeDiff('c-woo');
    expect(diff!.updated).toEqual([{ name: LIST, kind: 'structural' }]);
    expect(diff!.isSafeClass).toBe(false);
    await service.resync('c-woo', 'safe');
    const listId = tools.find((t: any) => t.name === LIST)!.id;
    expect(toolUpdate.mock.calls.find((c) => c[0].where.id === listId)).toBeUndefined();
    expect(connectorUpdate).not.toHaveBeenCalled();
  });

  it('still leaves a real endpoint change on another tool for an explicit update', async () => {
    const { service, toolUpdate, connectorUpdate, tools } = setup((all) => {
      all.find((t: any) => t.name === 'woocommerce_get_order')!.endpointMapping.path = '/old-path/{id}';
    });
    const diff = await service.computeDiff('c-woo');
    expect(diff!.updated).toEqual(
      expect.arrayContaining([
        { name: LIST, kind: 'safe', addedQueryParams: ['modified_after', 'modified_before', 'dates_are_gmt'] },
        { name: 'woocommerce_get_order', kind: 'structural' },
      ]),
    );
    expect(diff!.isSafeClass).toBe(false);
    await service.resync('c-woo', 'safe');
    const getId = tools.find((t: any) => t.name === 'woocommerce_get_order')!.id;
    const listId = tools.find((t: any) => t.name === LIST)!.id;
    expect(toolUpdate.mock.calls.find((c) => c[0].where.id === getId)).toBeUndefined();
    expect(toolUpdate.mock.calls.find((c) => c[0].where.id === listId)).toBeDefined();
    // Not fully in sync, so the version is not stamped.
    expect(connectorUpdate.mock.calls[0][0].data.config.adapterVersion).toBe('old');
  });
});
