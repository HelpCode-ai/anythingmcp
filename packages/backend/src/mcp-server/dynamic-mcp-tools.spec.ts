import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';

/**
 * Runtime behaviour of response shaping, the response cache and the workflow
 * hint — the three things that share the result-rendering path.
 */

const RAW = {
  pageDetails: { count: 1, totalCount: 812 },
  devices: [
    { id: 1, hostname: 'PC-01', deviceType: { category: 'Desktop' }, udf: { u1: 'x' } },
  ],
};

const SELECT_TRANSFORM = {
  transform: {
    select: {
      total: '$.pageDetails.totalCount',
      devices: { $from: '$.devices[*]', $select: { hostname: 'hostname', category: 'deviceType.category' } },
    },
  },
};

const MAPPED = { total: 812, devices: [{ hostname: 'PC-01', category: 'Desktop' }] };

function makeTool(responseMapping?: Record<string, unknown>): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    name: 'list_devices',
    description: 'List devices',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: { baseUrl: 'https://api.example.com', authType: 'NONE' },
    endpointMapping: { method: 'GET', path: '/devices' },
    responseMapping,
  };
}

function build(tool: RegisteredTool, opts: { engineResult?: unknown; cached?: string | null } = {}) {
  const redis = {
    get: jest.fn().mockResolvedValue(opts.cached ?? null),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
  const restEngine = {
    execute: jest.fn().mockResolvedValue(opts.engineResult ?? RAW),
  };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    audit as any,
    redis as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    restEngine as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { scheduleObservationalIngest: jest.fn() } as any,
  );
  return { executor, redis, audit, restEngine };
}

describe('DynamicMcpTools — response shaping', () => {
  it('leaves the output byte-identical when no transform is configured', async () => {
    const { executor } = build(makeTool());
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toBe(JSON.stringify(RAW, null, 2));
    expect(res.isError).toBeUndefined();
  });

  it('is a no-op when responseMapping only carries cacheTtl / followUp', async () => {
    const { executor } = build(makeTool({ cacheTtl: 0, followUp: undefined }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toBe(JSON.stringify(RAW, null, 2));
  });

  it('applies a configured transform to the text and to structuredContent', async () => {
    const { executor } = build(makeTool(SELECT_TRANSFORM));
    const res = await executor.executeTool('list_devices', {});
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
    expect(res.structured).toEqual(MAPPED);
  });

  it('applies the transform for every connector type, not just REST', async () => {
    const soapTool = { ...makeTool(SELECT_TRANSFORM), connectorType: 'SOAP' };
    const soapEngine = { execute: jest.fn().mockResolvedValue(RAW) };
    const executor = new DynamicMcpTools(
      { getTool: () => soapTool, getToolForOrg: () => soapTool } as any,
      { logInvocation: jest.fn() } as any,
      { get: jest.fn(), set: jest.fn() } as any,
      { checkLicenseActive: jest.fn() } as any,
      { isCloud: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
      soapEngine as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
    );
    const res = await executor.executeTool('list_devices', {});
    expect(soapEngine.execute).toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
  });

  it('appends the workflow hint after the mapped payload, and keeps structuredContent parseable', async () => {
    const { executor } = build(makeTool({ ...SELECT_TRANSFORM, followUp: 'now call get_device' }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toContain('WORKFLOW HINT');
    expect(res.content[0].text.startsWith(JSON.stringify(MAPPED, null, 2))).toBe(true);
    // The whole text is no longer valid JSON — this is exactly why the
    // executor hands back `structured` instead of making callers re-parse it.
    expect(() => JSON.parse(res.content[0].text)).toThrow();
    expect(res.structured).toEqual(MAPPED);
  });

  it('audits the RAW response, not the mapped one', async () => {
    const { executor, audit } = build(makeTool(SELECT_TRANSFORM));
    await executor.executeTool('list_devices', {});
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ output: RAW, status: 'SUCCESS' }),
    );
  });

  it('returns the raw response and does not fail the call when the mapping is broken', async () => {
    const { executor } = build(makeTool({ transform: { select: { bad: 'a[' } } }));
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual(RAW);
  });

  it('surfaces the error instead when fallbackToRaw is false', async () => {
    const { executor } = build(
      makeTool({ transform: { fallbackToRaw: false, select: { bad: 'a[' } } }),
    );
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/Response mapping failed/);
  });
});

describe('DynamicMcpTools — response cache', () => {
  it('caches the raw response, not the rendered text', async () => {
    const { executor, redis } = build(makeTool({ ...SELECT_TRANSFORM, cacheTtl: 300 }));
    await executor.executeTool('list_devices', {});
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = redis.set.mock.calls[0];
    expect(key).toMatch(/^tool_cache:v2:list_devices:/);
    expect(ttl).toBe(300);
    expect(JSON.parse(value)).toEqual(RAW);
  });

  it('re-applies the mapping on a cache hit, so a mapping edit takes effect at once', async () => {
    const { executor, restEngine } = build(makeTool({ ...SELECT_TRANSFORM, cacheTtl: 300 }), {
      cached: JSON.stringify(RAW),
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).not.toHaveBeenCalled(); // served from cache
    expect(JSON.parse(res.content[0].text)).toEqual(MAPPED);
    expect(res.structured).toEqual(MAPPED);
  });

  it('re-executes rather than serving an unparsable cache entry', async () => {
    const { executor, restEngine } = build(makeTool({ cacheTtl: 300 }), {
      cached: 'not json{',
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual(RAW);
  });

  it('does not touch the cache when cacheTtl is absent', async () => {
    const { executor, redis } = build(makeTool(SELECT_TRANSFORM));
    await executor.executeTool('list_devices', {});
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});

/**
 * Which tool a name resolves to, when two tenants have registered the same one.
 *
 * This is the multi-tenant boundary of the shared `/mcp` endpoint. Until
 * 12 Sep 2026 resolution ran `getTool(name, context.connectorIds)` first and
 * only fell back to the organization `if (!tool)`. On `/mcp` there are no
 * `connectorIds`, and an unfiltered `getTool` returns whichever connector
 * registered the name FIRST across the whole deployment — so the fallback never
 * ran and the caller executed somebody else's connector, with that tenant's
 * credentials. Verified on production: two fresh tenants both invoked a third,
 * unrelated workspace's connector. 610 tool names were shared across more than
 * one organization at the time; one was shared by 76.
 */
describe('DynamicMcpTools — tool resolution is scoped to the caller', () => {
  // Distinct base URLs, so "which connector ran" is something the test can
  // actually see — the same way the production reproduction identified it.
  const mine: RegisteredTool = {
    ...makeTool(),
    id: 'tool-mine',
    connectorId: 'conn-mine',
    organizationId: 'org-mine',
    connectorConfig: { baseUrl: 'https://mine.example.com', authType: 'NONE' },
  };
  const theirs: RegisteredTool = {
    ...makeTool(),
    id: 'tool-theirs',
    connectorId: 'conn-theirs',
    organizationId: 'org-theirs',
    connectorConfig: { baseUrl: 'https://theirs.example.com', authType: 'NONE' },
  };

  /** A registry that behaves like the real one: same name, two owners. */
  function registry() {
    const calls: string[] = [];
    return {
      calls,
      // Unfiltered → first registered wins, exactly as ToolRegistry does.
      getTool: (name: string, connectorIds?: string[]) => {
        calls.push(connectorIds ? `getTool(${connectorIds.join()})` : 'getTool(unscoped)');
        const candidates = [theirs, mine].filter((t) => t.name === name);
        if (!connectorIds) return candidates[0];
        return candidates.find((t) => connectorIds.includes(t.connectorId));
      },
      getToolForOrg: (name: string, organizationId: string) => {
        calls.push(`getToolForOrg(${organizationId})`);
        return [theirs, mine].find(
          (t) => t.name === name && t.organizationId === organizationId,
        );
      },
    };
  }

  function executorWith(reg: ReturnType<typeof registry>) {
    const restEngine = { execute: jest.fn().mockResolvedValue(RAW) };
    const executor = new DynamicMcpTools(
      reg as any,
      { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() } as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => true } as any,
      {} as any,
      restEngine as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
    );
    return { executor, restEngine };
  }

  it('runs MY connector, not the one that registered the name first', async () => {
    const reg = registry();
    const { executor, restEngine } = executorWith(reg);

    await executor.executeTool('list_devices', {}, { organizationId: 'org-mine' });

    expect(restEngine.execute).toHaveBeenCalledTimes(1);
    const [config] = restEngine.execute.mock.calls[0];
    expect(config.baseUrl).toBe('https://mine.example.com');
    // The scoped lookup is the one that must have been consulted.
    expect(reg.calls).toContain('getToolForOrg(org-mine)');
    expect(reg.calls).not.toContain('getTool(unscoped)');
  });

  it('refuses rather than widening when my organization has no such tool', async () => {
    const reg = registry();
    const { executor, restEngine } = executorWith(reg);

    const res = await executor.executeTool('list_devices', {}, {
      organizationId: 'org-with-nothing',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
    expect(restEngine.execute).not.toHaveBeenCalled();
    expect(reg.calls).not.toContain('getTool(unscoped)');
  });

  it('uses the server scope when the call came through /mcp/:serverId', async () => {
    const reg = registry();
    const { executor } = executorWith(reg);

    await executor.executeTool('list_devices', {}, {
      organizationId: 'org-mine',
      connectorIds: ['conn-mine'],
    });

    expect(reg.calls).toContain('getTool(conn-mine)');
    expect(reg.calls).not.toContain('getToolForOrg(org-mine)');
  });

  it('does not fall back to the organization when the server has no such tool', async () => {
    const reg = registry();
    const { executor, restEngine } = executorWith(reg);

    const res = await executor.executeTool('list_devices', {}, {
      organizationId: 'org-mine',
      connectorIds: ['conn-unrelated'],
    });

    expect(res.isError).toBe(true);
    expect(restEngine.execute).not.toHaveBeenCalled();
  });

  // A self-hosted box with an instance-level MCP_API_KEY has no tenant to scope
  // to, and "any tool" is the right answer there.
  it('still resolves unscoped for an instance credential with no organization', async () => {
    const reg = registry();
    const { executor, restEngine } = executorWith(reg);

    await executor.executeTool('list_devices', {}, {});

    expect(reg.calls).toContain('getTool(unscoped)');
    expect(restEngine.execute).toHaveBeenCalled();
  });
});
