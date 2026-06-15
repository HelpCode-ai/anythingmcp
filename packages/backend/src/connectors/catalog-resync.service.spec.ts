import { CatalogResyncService } from './catalog-resync.service';
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
