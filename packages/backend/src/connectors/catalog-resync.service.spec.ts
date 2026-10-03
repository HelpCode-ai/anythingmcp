import { CatalogResyncService, diffBaseUrl } from './catalog-resync.service';
import { getAdapter } from '../adapters/catalog';
import {
  computeAdapterVersion,
  hashInstructions,
} from '../adapters/catalog-fingerprint';

const SLUG = 'weclapp';

function connectorFromCatalog(mutate?: (tools: any[]) => void) {
  const adapter = getAdapter(SLUG)!;
  const tools = adapter.tools.map((t: any, i: number) => ({
    id: `tool${i}`,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    endpointMapping: t.endpointMapping,
    responseMapping: t.responseMapping ?? null,
    useProxy: t.useProxy === true,
    isEnabled: true,
    deprecatedAt: null,
  }));
  if (mutate) mutate(tools);
  return {
    id: 'c1',
    name: adapter.connector.name,
    instructions: adapter.instructions ?? null,
    config: {
      adapterSlug: SLUG,
      adapterVersion: adapter.version,
      instructionsBaseline: hashInstructions(adapter.instructions),
    },
    tools,
  };
}

function serviceFor(connector: any) {
  const prisma = {
    connector: { findUnique: jest.fn().mockResolvedValue(connector) },
  } as any;
  return new CatalogResyncService(prisma);
}

describe('catalog fingerprint', () => {
  it('adapter version is deterministic and 12 hex chars', () => {
    const a = getAdapter(SLUG)!;
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(computeAdapterVersion(a)).toBe(a.version);
  });

  it('version changes when a tool description changes', () => {
    const a = getAdapter(SLUG)!;
    const mutated = {
      ...a,
      tools: a.tools.map((t: any, i: number) =>
        i === 0 ? { ...t, description: t.description + ' (changed)' } : t,
      ),
    };
    expect(computeAdapterVersion(mutated as any)).not.toBe(a.version);
  });
});

describe('CatalogResyncService.computeDiff', () => {
  it('reports up-to-date when the connector matches the catalog', async () => {
    const svc = serviceFor(connectorFromCatalog());
    const diff = await svc.computeDiff('c1');
    expect(diff).not.toBeNull();
    expect(diff!.isUpToDate).toBe(true);
    expect(diff!.isSafeClass).toBe(false);
    expect(diff!.updated).toHaveLength(0);
  });

  it('classifies a description-only change as safe', async () => {
    const svc = serviceFor(
      connectorFromCatalog((tools) => {
        tools[0].description = 'stale description';
      }),
    );
    const diff = await svc.computeDiff('c1');
    expect(diff!.isUpToDate).toBe(false);
    expect(diff!.isSafeClass).toBe(true);
    expect(diff!.updated).toEqual([
      { name: tools0Name(), kind: 'safe' },
    ]);
  });

  it('classifies a parameters-only change as safe', async () => {
    const svc = serviceFor(
      connectorFromCatalog((tools) => {
        tools[0].parameters = { type: 'object', properties: {} };
      }),
    );
    const diff = await svc.computeDiff('c1');
    expect(diff!.isSafeClass).toBe(true);
    expect(diff!.updated[0].kind).toBe('safe');
  });

  it('classifies an endpoint change as structural', async () => {
    const svc = serviceFor(
      connectorFromCatalog((tools) => {
        tools[0].endpointMapping = { method: 'GET', path: '/changed' };
      }),
    );
    const diff = await svc.computeDiff('c1');
    expect(diff!.isSafeClass).toBe(false);
    expect(diff!.updated[0].kind).toBe('structural');
  });

  it('treats a missing catalog tool as a structural addition', async () => {
    const svc = serviceFor(
      connectorFromCatalog((tools) => {
        tools.shift(); // connector is missing the first catalog tool
      }),
    );
    const diff = await svc.computeDiff('c1');
    expect(diff!.added.length).toBe(1);
    expect(diff!.isSafeClass).toBe(false);
  });

  it('treats an extra connector tool as a structural removal', async () => {
    const svc = serviceFor(
      connectorFromCatalog((tools) => {
        tools.push({
          id: 'extra',
          name: 'weclapp_unknown_tool',
          description: 'x',
          parameters: {},
          endpointMapping: { method: 'GET', path: '/x' },
          responseMapping: null,
          useProxy: false,
          isEnabled: true,
          deprecatedAt: null,
          origin: 'catalog',
        });
      }),
    );
    const diff = await svc.computeDiff('c1');
    expect(diff!.removed).toContain('weclapp_unknown_tool');
    expect(diff!.isSafeClass).toBe(false);
  });

  it('returns null for a connector with no resolvable catalog slug', async () => {
    const c = connectorFromCatalog();
    c.config = {} as any;
    c.name = 'Totally Custom Connector';
    const svc = serviceFor(c);
    expect(await svc.computeDiff('c1')).toBeNull();
  });
});

function tools0Name(): string {
  return getAdapter(SLUG)!.tools[0].name;
}


/**
 * Base URL drift.
 *
 * Correcting a hostname in the catalog does not reach connectors already
 * installed — NINA kept calling nina.api.proxy.bund.dev, which has no DNS
 * record, for a day after the catalog was fixed. The obvious repair, copying
 * the catalog value over, would also have repointed the two connectors whose
 * operators had deliberately chosen a different host: datadog at the us3
 * region, DATEV at the sandbox. Hence a proposal rather than an overwrite.
 */
describe('diffBaseUrl', () => {
  const CAT = 'https://warnung.bund.de/api31';

  it('reports nothing when they agree', () => {
    expect(diffBaseUrl(CAT, CAT, CAT)).toBeNull();
  });

  it('ignores a trailing slash', () => {
    expect(diffBaseUrl(CAT, `${CAT}/`, CAT)).toBeNull();
  });

  it('never compares a templated catalog URL', () => {
    // The connector holds the resolved form, so every templated adapter would
    // otherwise report a change on every single diff.
    expect(
      diffBaseUrl(
        'https://{{TENANT}}.weclapp.com/webapp/api/v1',
        'https://acme.weclapp.com/webapp/api/v1',
        null,
      ),
    ).toBeNull();
  });

  it('calls it catalog-moved when the connector still holds what it was given', () => {
    const old = 'https://nina.api.proxy.bund.dev/api31';
    expect(diffBaseUrl(CAT, old, old)).toEqual({
      from: old,
      to: CAT,
      provenance: 'catalog-moved',
    });
  });

  it('calls it user-edited when the operator moved it themselves', () => {
    // datadog: installed against api.datadoghq.com, pointed at us3 on purpose.
    const change = diffBaseUrl(
      'https://api.datadoghq.com',
      'https://api.us3.datadoghq.com',
      'https://api.datadoghq.com',
    );
    expect(change?.provenance).toBe('user-edited');
  });

  it('calls it unknown when no baseline was recorded', () => {
    // Everything installed before baseUrlBaseline existed. Indistinguishable,
    // so it is shown and left to a human.
    const change = diffBaseUrl(CAT, 'https://old.example.com', null);
    expect(change?.provenance).toBe('unknown');
  });
});

describe('CatalogResyncService.computeDiff — baseUrl', () => {
  const NINA = 'nina-warnung';

  function ninaConnector(baseUrl: string, baseline?: string | null) {
    const adapter = getAdapter(NINA)!;
    return {
      id: 'c-nina',
      name: adapter.connector.name,
      baseUrl,
      instructions: adapter.instructions ?? null,
      config: {
        adapterSlug: NINA,
        adapterVersion: adapter.version,
        instructionsBaseline: hashInstructions(adapter.instructions),
        ...(baseline === undefined ? {} : { baseUrlBaseline: baseline }),
      },
      tools: adapter.tools.map((t: any, i: number) => ({
        id: `t${i}`,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        endpointMapping: t.endpointMapping,
        responseMapping: t.responseMapping ?? null,
        useProxy: t.useProxy === true,
        isEnabled: true,
        deprecatedAt: null,
      })),
    };
  }

  it('is up to date when the base URL matches', async () => {
    const adapter = getAdapter(NINA)!;
    const svc = serviceFor(ninaConnector(adapter.connector.baseUrl));
    const diff = await svc.computeDiff('c-nina');
    expect(diff!.baseUrl).toBeNull();
    expect(diff!.isUpToDate).toBe(true);
  });

  it('reports a drifted base URL and is no longer up to date', async () => {
    const stale = 'https://nina.api.proxy.bund.dev/api31';
    const svc = serviceFor(ninaConnector(stale, stale));
    const diff = await svc.computeDiff('c-nina');
    expect(diff!.baseUrl).toEqual({
      from: stale,
      to: getAdapter(NINA)!.connector.baseUrl,
      provenance: 'catalog-moved',
    });
    expect(diff!.isUpToDate).toBe(false);
  });

  it('keeps a base-URL change out of the safe class', async () => {
    // The boot-time reconciler applies safe-class diffs unattended. It must
    // never be able to repoint a customer's connector at a different host.
    const stale = 'https://nina.api.proxy.bund.dev/api31';
    const svc = serviceFor(ninaConnector(stale, stale));
    const diff = await svc.computeDiff('c-nina');
    expect(diff!.isSafeClass).toBe(false);
  });
});

describe('CatalogResyncService.resync — baseUrl is never applied unasked', () => {
  const NINA = 'nina-warnung';
  const STALE = 'https://nina.api.proxy.bund.dev/api31';

  function setup() {
    const adapter = getAdapter(NINA)!;
    const connector = {
      id: 'c-nina',
      name: adapter.connector.name,
      baseUrl: STALE,
      instructions: adapter.instructions ?? null,
      config: {
        adapterSlug: NINA,
        adapterVersion: adapter.version,
        instructionsBaseline: hashInstructions(adapter.instructions),
        baseUrlBaseline: STALE,
      },
      tools: adapter.tools.map((t: any, i: number) => ({
        id: `t${i}`,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        endpointMapping: t.endpointMapping,
        responseMapping: t.responseMapping ?? null,
        useProxy: t.useProxy === true,
        isEnabled: true,
        deprecatedAt: null,
      })),
    };
    const connectorUpdate = jest.fn().mockResolvedValue({});
    const tx = {
      connector: {
        findUnique: jest.fn().mockResolvedValue(connector),
        update: connectorUpdate,
      },
      mcpTool: {
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      connector: { findUnique: jest.fn().mockResolvedValue(connector) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    } as any;
    return { service: new CatalogResyncService(prisma), connectorUpdate, adapter };
  }

  it('leaves the base URL alone by default, even in full mode', async () => {
    const { service, connectorUpdate } = setup();
    const { applied } = await service.resync('c-nina', 'full');
    expect(applied).toBe(true);
    expect(connectorUpdate).toHaveBeenCalledTimes(1);
    expect(connectorUpdate.mock.calls[0][0].data.baseUrl).toBeUndefined();
  });

  it('moves it when the caller explicitly asks, and re-baselines', async () => {
    const { service, connectorUpdate, adapter } = setup();
    await service.resync('c-nina', 'full', { applyBaseUrl: true });
    const data = connectorUpdate.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(adapter.connector.baseUrl);
    // Without re-baselining, the next diff would read our own fix as an
    // operator edit and stop offering anything ever again.
    expect(data.config.baseUrlBaseline).toBe(adapter.connector.baseUrl);
  });

  it('refuses in safe mode even when asked', async () => {
    // Safe mode is what the unattended boot-time reconciler uses.
    const { service, connectorUpdate } = setup();
    await service.resync('c-nina', 'safe', { applyBaseUrl: true });
    expect(connectorUpdate).not.toHaveBeenCalled();
  });
});

describe('CatalogResyncService — the user\'s own tools are never touched', () => {
  const userTool = (over: Record<string, unknown> = {}) => ({
    id: 'mine',
    name: 'weclapp_my_custom_report',
    description: 'mine',
    parameters: {},
    endpointMapping: { method: 'GET', path: '/mine' },
    responseMapping: null,
    useProxy: false,
    isEnabled: true,
    deprecatedAt: null,
    ...over,
  });

  it('lists a tool the user added as custom, not as removed', async () => {
    const svc = serviceFor(connectorFromCatalog((tools) => tools.push(userTool({ origin: 'user' }))));
    const diff = await svc.computeDiff('c1');
    expect(diff!.removed).toEqual([]);
    expect(diff!.custom).toEqual(['weclapp_my_custom_report']);
    // Nothing else changed: still up to date.
    expect(diff!.isUpToDate).toBe(true);
  });

  it('decides rows from before the origin column by age', async () => {
    const created = new Date('2026-09-01T10:00:00Z');
    const c: any = connectorFromCatalog((tools) => {
      tools.push(userTool({ origin: null, createdAt: new Date('2026-09-20T10:00:00Z') }));
      tools.push(userTool({ id: 'old', name: 'weclapp_dropped_upstream', origin: null, createdAt: new Date('2026-09-01T10:01:00Z') }));
    });
    c.createdAt = created;
    const diff = await serviceFor(c).computeDiff('c1');
    expect(diff!.custom).toEqual(['weclapp_my_custom_report']);
    expect(diff!.removed).toEqual(['weclapp_dropped_upstream']);
  });

  function applySetup(mutate: (tools: any[]) => void) {
    const connector: any = connectorFromCatalog(mutate);
    connector.config = { ...connector.config, adapterVersion: 'old-version' };
    const tx = {
      connector: { findUnique: jest.fn().mockResolvedValue(connector), update: jest.fn().mockResolvedValue({}) },
      mcpTool: { update: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      connector: { findUnique: jest.fn().mockResolvedValue(connector) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    } as any;
    return { service: new CatalogResyncService(prisma), tx };
  }

  it('a full update never retires the user\'s tool, and marks new tools as catalog', async () => {
    const { service, tx } = applySetup((tools) => {
      tools.push(userTool({ origin: 'user' }));
      tools.splice(0, 1); // a catalog tool missing → will be added
    });
    await service.resync('c1', 'full');
    const retired = tx.mcpTool.update.mock.calls.filter((c: any) => c[0].data.deprecatedAt instanceof Date);
    expect(retired.map((c: any) => c[0].where.id)).not.toContain('mine');
    expect(tx.mcpTool.create).toHaveBeenCalledTimes(1);
    expect(tx.mcpTool.create.mock.calls[0][0].data.origin).toBe('catalog');
  });

  it('safe mode applies description fixes even when a new tool is also pending', async () => {
    const { service, tx } = applySetup((tools) => {
      tools[1] = { ...tools[1], description: 'stale description' };
      tools.splice(0, 1); // structural: a tool to add
    });
    const { applied, diff } = await service.resync('c1', 'safe');
    expect(diff.isSafeClass).toBe(false);
    expect(applied).toBe(true);
    expect(tx.mcpTool.create).not.toHaveBeenCalled();
    const fixed = tx.mcpTool.update.mock.calls.find((c: any) => c[0].data.description !== 'stale description');
    expect(fixed).toBeDefined();
    // Not stamped as in sync: the structural part is still pending.
    const cfg = tx.connector.update.mock.calls[0][0].data.config;
    expect(cfg.adapterVersion).toBe('old-version');
  });

  it('safe mode does nothing when only structural changes are pending', async () => {
    const { service, tx } = applySetup((tools) => tools.splice(0, 1));
    const { applied } = await service.resync('c1', 'safe');
    expect(applied).toBe(false);
    expect(tx.connector.update).not.toHaveBeenCalled();
  });
});

describe('CatalogResyncService.computeDiff for an MCP adapter', () => {
  // The workspace's own MCP server owns the tool list: a catalog snapshot that
  // differs from it (another server version) must not be offered as an update,
  // and tools the server added must not be retired.
  it('never adds, rewrites or retires the tools of an MCP adapter', async () => {
    const adapter = getAdapter('splunk')!;
    const connector = {
      id: 'c1',
      name: adapter.connector.name,
      baseUrl: 'https://acme.splunkcloud.com:8089/services/mcp',
      instructions: adapter.instructions ?? null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      config: {
        adapterSlug: 'splunk',
        adapterVersion: adapter.version,
        instructionsBaseline: hashInstructions(adapter.instructions),
      },
      tools: [
        {
          id: 't1',
          name: 'splunk_run_query',
          description: 'what this server version says',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
          endpointMapping: { method: 'splunk_run_query', path: '/mcp' },
          origin: 'catalog',
          deprecatedAt: null,
        },
        {
          id: 't2',
          name: 'splunk_tool_from_a_newer_server',
          description: 'new upstream tool',
          parameters: {},
          endpointMapping: { method: 'splunk_tool_from_a_newer_server', path: '/mcp' },
          origin: 'catalog',
          deprecatedAt: null,
        },
      ],
    };
    const diff = await serviceFor(connector).computeDiff('c1');
    expect(diff!.updated).toEqual([]);
    expect(diff!.added).toEqual([]);
    expect(diff!.removed).toEqual([]);
    expect(diff!.isUpToDate).toBe(true);
  });
});
