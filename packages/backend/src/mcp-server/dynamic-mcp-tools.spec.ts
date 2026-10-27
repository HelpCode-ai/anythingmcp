import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { Logger } from '@nestjs/common';
import * as metrics from '../common/metrics';
import { processGauges } from '../common/process-vitals';

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

function build(tool: RegisteredTool, opts: { engineResult?: unknown; cached?: string | null; cloud?: boolean } = {}) {
  const redis = {
    get: jest.fn().mockResolvedValue(opts.cached ?? null),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
  const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
  const engineResult = opts.engineResult ?? RAW;
  const restEngine = { execute: jest.fn().mockResolvedValue(engineResult) };
  const mcpClientEngine = { execute: jest.fn().mockResolvedValue(engineResult) };
  const graphqlEngine = { execute: jest.fn().mockRejectedValue(new Error('Unexpected GraphQL call')) };
  const soapEngine = { execute: jest.fn().mockRejectedValue(new Error('Unexpected SOAP call')) };
  const databaseEngine = { execute: jest.fn().mockRejectedValue(new Error('Unexpected database call')) };
  const odataEngine = { execute: jest.fn().mockRejectedValue(new Error('Unexpected OData call')) };
  const kg = { scheduleObservationalIngest: jest.fn() };
  const license = { checkLicenseActive: jest.fn().mockResolvedValue(undefined) };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    audit as any,
    redis as any,
    license as any,
    { isCloud: () => opts.cloud ?? false } as any,
    {} as any,
    restEngine as any,
    graphqlEngine as any,
    soapEngine as any,
    mcpClientEngine as any,
    databaseEngine as any,
    kg as any,
    odataEngine as any,
  );
  const engines = { REST: restEngine, MCP: mcpClientEngine, GRAPHQL: graphqlEngine, SOAP: soapEngine, DATABASE: databaseEngine, ODATA: odataEngine };
  return { executor, redis, audit, restEngine, mcpClientEngine, kg, license, engines };
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

describe('DynamicMcpTools — actionable hint on upstream errors', () => {
  it('appends a hint for a weclapp "unknown property" 400, next to the vendor body', async () => {
    const { AxiosError } = await import('axios');
    const tool = makeTool();
    tool.connectorConfig = { baseUrl: 'https://purora.weclapp.com/webapp/api/v2', authType: 'NONE' };
    const { executor, restEngine, audit } = build(tool);
    const err = new AxiosError('Request failed with status code 400', '400', { url: '/salesOrder', baseURL: tool.connectorConfig.baseUrl } as any, undefined, {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: {} as any,
      data: { detail: 'unknown property: orderItems.articleNumber', status: 400 },
    });
    restEngine.execute.mockRejectedValueOnce(err);

    const res = await executor.executeTool('list_devices', {});

    expect(res.isError).toBe(true);
    const detail = JSON.parse(res.content[0].text);
    // The vendor's own message is still there, unmodified…
    expect(detail.responseBody.detail).toBe('unknown property: orderItems.articleNumber');
    // …and the hint sits beside it.
    expect(detail.hint).toMatch(/fetch ONE record/);
    // The audit row keeps the raw upstream cause, not the hint.
    expect(audit.logInvocation.mock.calls[0][0].error).toMatch(/unknown property/);
    expect(audit.logInvocation.mock.calls[0][0].error).not.toMatch(/fetch ONE record/);
  });

  it("returns the engine's own hint (a refused refresh token) to the model", async () => {
    const { executor, restEngine } = build(makeTool());
    const hint =
      "Google revoked the sign-in 7 days after it was granted. This happens when the OAuth app in your Google Cloud project is in 'Testing'.";
    restEngine.execute.mockRejectedValueOnce(
      Object.assign(new Error(`OAuth2: the provider refused this connector's refresh token. ${hint}`), {
        status: 401,
        hint,
      }),
    );
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).hint).toBe(hint);
  });

  it('returns the response size error as a tool error with its own code', async () => {
    const { ResponseTooLargeError } = await import('../common/response-size-limit');
    const { executor, restEngine } = build(makeTool());
    restEngine.execute.mockRejectedValueOnce(new ResponseTooLargeError(10 * 1024 * 1024));
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    const detail = JSON.parse(res.content[0].text);
    expect(detail.code).toBe('TOOL_RESPONSE_TOO_LARGE');
    expect(detail.error).toMatch(/larger than 10 MB, the limit for one tool call/);
    expect(detail.status).toBeUndefined();
  });

  it('adds no hint for an ordinary failure on an unknown host', async () => {
    const { executor, restEngine } = build(makeTool());
    restEngine.execute.mockRejectedValueOnce(new Error('boom'));
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).hint).toBeUndefined();
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

describe('DynamicMcpTools — exposed response headers (pagination)', () => {
  const LINK =
    '<https://api.example.com/devices?cursor=abc>; rel="next", <https://api.example.com/devices?cursor=000>; rel="prev"';
  const PAGE = { items: [{ id: 1 }] };

  function pagedTool(exposeHeaders?: string[], responseMapping?: Record<string, unknown>) {
    const tool = makeTool(responseMapping);
    tool.endpointMapping = { method: 'GET', path: '/devices', ...(exposeHeaders ? { exposeHeaders } : {}) };
    return tool;
  }

  function buildPaged(tool: RegisteredTool, headers: Record<string, string>, cached?: string) {
    const built = build(tool, { engineResult: PAGE, cached });
    (built.restEngine as any).executeWithMeta = jest
      .fn()
      .mockResolvedValue({ body: PAGE, headers });
    return built;
  }

  it('does not touch the engine\'s header path, nor the output, for a tool that did not opt in', async () => {
    const { executor, restEngine } = buildPaged(pagedTool(), { link: LINK });
    const res = await executor.executeTool('list_devices', {});
    expect((restEngine as any).executeWithMeta).not.toHaveBeenCalled();
    expect(restEngine.execute).toHaveBeenCalled();
    expect(res.structured).toEqual(PAGE);
  });

  it('puts the asked-for headers and the next cursor next to the body', async () => {
    const { executor } = buildPaged(pagedTool(['link']), { link: LINK });
    const res = await executor.executeTool('list_devices', {});
    expect(res.structured).toEqual({
      items: [{ id: 1 }],
      _headers: { link: LINK },
      _pagination: {
        nextUrl: 'https://api.example.com/devices?cursor=abc',
        nextCursor: 'abc',
        cursorParam: 'cursor',
        prevUrl: 'https://api.example.com/devices?cursor=000',
      },
    });
    expect(JSON.parse(res.content[0].text)._pagination.nextCursor).toBe('abc');
  });

  it('omits _pagination on the last page, so its absence is the signal', async () => {
    const { executor } = buildPaged(pagedTool(['link', 'x-ratelimit-remaining']), {
      link: '<https://api.example.com/devices?cursor=000>; rel="prev"',
      'x-ratelimit-remaining': '41',
    });
    const res = await executor.executeTool('list_devices', {});
    const out = res.structured as any;
    expect(out._pagination).toBeUndefined();
    expect(out._headers['x-ratelimit-remaining']).toBe('41');
  });

  it('wraps a non-object body as data instead of losing the extras', async () => {
    const built = buildPaged(pagedTool(['link']), { link: LINK });
    (built.restEngine as any).executeWithMeta.mockResolvedValue({ body: [1, 2], headers: { link: LINK } });
    const res = await built.executor.executeTool('list_devices', {});
    expect((res.structured as any).data).toEqual([1, 2]);
    expect((res.structured as any)._pagination.nextCursor).toBe('abc');
  });

  it('applies the response transform to the body first, then attaches the extras', async () => {
    const built = buildPaged(
      pagedTool(['link'], { transform: { select: { first: '$.items[0].id' } } }),
      { link: LINK },
    );
    const res = await built.executor.executeTool('list_devices', {});
    expect(res.structured).toMatchObject({ first: 1, _pagination: { nextCursor: 'abc' } });
  });

  it('audits the bare body: headers never reach the log', async () => {
    const { executor, audit } = buildPaged(pagedTool(['link']), { link: LINK });
    await executor.executeTool('list_devices', {});
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ output: PAGE, status: 'SUCCESS' }),
    );
  });

  it('caches body and headers together, and a cache hit still carries the cursor', async () => {
    const { executor, redis } = buildPaged(pagedTool(['link'], { cacheTtl: 60 }), { link: LINK });
    await executor.executeTool('list_devices', {});
    const stored = JSON.parse(redis.set.mock.calls[0][1]);
    expect(stored).toEqual({ __amcpEnvelope: 1, body: PAGE, meta: { headers: { link: LINK } } });

    const hit = buildPaged(pagedTool(['link'], { cacheTtl: 60 }), {}, redis.set.mock.calls[0][1]);
    const res = await hit.executor.executeTool('list_devices', {});
    expect((hit.restEngine as any).executeWithMeta).not.toHaveBeenCalled();
    expect((res.structured as any)._pagination.nextCursor).toBe('abc');
  });

  it('still reads a cache entry written before envelopes existed', async () => {
    const hit = buildPaged(pagedTool(['link'], { cacheTtl: 60 }), {}, JSON.stringify(PAGE));
    const res = await hit.executor.executeTool('list_devices', {});
    expect(res.structured).toEqual(PAGE);
  });
});


describe('DynamicMcpTools — credentials that were filled in after the install', () => {
  /**
   * authConfig used to be substituted once, at import time, from whatever the
   * install form was given. Install the connector first, paste the credentials
   * later, and it kept sending "{{MY_KEY}}" to the vendor forever. Caught on a
   * live Etsy connector on 2026-09-17, where the vendor's complaint about the
   * key format read exactly like the bug we had fixed that morning.
   */
  function toolWithEnv(authConfig: Record<string, unknown>, envVars: Record<string, string>) {
    const tool = makeTool();
    tool.connectorConfig = {
      baseUrl: 'https://api.example.com',
      authType: 'API_KEY',
      authConfig: JSON.stringify(authConfig),
      envVars,
    };
    return tool;
  }

  it('resolves {{VAR}} inside authConfig from the connector env vars at call time', async () => {
    const tool = toolWithEnv(
      { headerName: 'x-api-key', apiKey: '{{SHOP_ID}}:{{SHOP_SECRET}}' },
      { SHOP_ID: 'shop-42', SHOP_SECRET: 's3cr3t' },
    );
    const { executor, restEngine } = build(tool, { engineResult: { ok: true } });

    await executor.executeTool('list_devices', {});

    const [config] = (restEngine.execute as jest.Mock).mock.calls[0];
    expect(config.authConfig).toEqual({
      headerName: 'x-api-key',
      apiKey: 'shop-42:s3cr3t',
    });
  });

  it('refuses the call, naming the variables, when nobody ever set them', async () => {
    const tool = toolWithEnv(
      { headerName: 'x-api-key', apiKey: '{{SHOP_ID}}:{{SHOP_SECRET}}' },
      {},
    );
    const { executor, restEngine } = build(tool, { engineResult: { ok: true } });

    const res = await executor.executeTool('list_devices', {});

    expect(restEngine.execute).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/SHOP_ID, SHOP_SECRET/);
  });
});

describe('DynamicMcpTools — a base URL variable without https://', () => {
  it('names the variable instead of failing in the SSRF guard', async () => {
    // A Substack install from before the save-time check: the publication was
    // typed as a bare host and stored as the base URL verbatim.
    const tool = makeTool();
    tool.connectorConfig = {
      baseUrl: 'yourname.substack.com',
      authType: 'NONE',
      envVars: { SUBSTACK_PUBLICATION_URL: 'yourname.substack.com' },
    };
    const { executor, restEngine } = build(tool, { engineResult: { ok: true } });

    const res = await executor.executeTool('list_devices', {});

    expect(restEngine.execute).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toContain(
      'SUBSTACK_PUBLICATION_URL must be a full URL such as https://yourname.substack.com',
    );
    expect(text).not.toMatch(/SSRF/);
  });
});

describe('DynamicMcpTools — connector not authorized yet', () => {
  it('says to authorize, with the link, instead of naming the refresh-token variable', async () => {
    const saved = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://cloud.example.com';
    try {
      const tool = makeTool();
      tool.setupStatus = 'needs_authorization';
      tool.connectorConfig = {
        baseUrl: 'https://openapi.etsy.com/v3/application',
        authType: 'OAUTH2',
        authConfig: JSON.stringify({ refreshToken: '{{ETSY_REFRESH_TOKEN}}' }),
      };
      const { executor, restEngine } = build(tool);
      const res = await executor.executeTool('list_devices', {});
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      expect(text).toContain('has not been authorized yet');
      expect(text).toContain('https://cloud.example.com/connectors/conn-1');
      expect(text).not.toContain('ETSY_REFRESH_TOKEN');
      expect(restEngine.execute).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = saved;
    }
  });
});

describe('DynamicMcpTools: images in the response', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString('base64');
  const GENERATED = { created: 1760000000, output_format: 'png', data: [{ b64_json: PNG }] };

  it('returns the image as MCP image content after the text, which keeps a placeholder', async () => {
    const { executor, audit } = build(makeTool({ images: { paths: ['data[*].b64_json'] } }), { engineResult: GENERATED });
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).not.toContain(PNG);
    expect(JSON.parse(res.content[0].text).data[0].b64_json).toMatch(/^\[image 1: image\/png/);
    expect(res.content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(JSON.stringify(res.structured)).not.toContain(PNG);
    expect(audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS' }));
  });

  it('adds no image content for tools without the option, even when the body holds base64', async () => {
    const { executor } = build(makeTool(), { engineResult: GENERATED });
    const res = await executor.executeTool('list_devices', {});
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toBe(JSON.stringify(GENERATED, null, 2));
  });
});

describe('DynamicMcpTools: binary responses', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  const PDF = Buffer.from('%PDF-1.7 not really a pdf but binary enough');
  const file = (buf: Buffer, contentType: string, filename?: string) => ({
    __amcpBinary: 1,
    contentType,
    bytes: buf.length,
    ...(filename ? { filename } : {}),
    base64: buf.toString('base64'),
  });

  it('attaches a downloaded image as image content and keeps the bytes out of the text and the audit log', async () => {
    const { executor, audit } = build(makeTool(), { engineResult: file(JPEG, 'application/octet-stream') });
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).not.toContain(JPEG.toString('base64'));
    expect(JSON.parse(res.content[0].text).file).toMatchObject({ contentType: 'application/octet-stream', bytes: JPEG.length });
    expect(res.content[1]).toEqual({ type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' });
    const logged = JSON.stringify(audit.logInvocation.mock.calls[0][0].output);
    expect(logged).not.toContain(JPEG.toString('base64'));
    expect(logged).toContain('binary data not stored');
  });

  it('attaches any other file as an embedded resource, and the response mapping does not touch it', async () => {
    const tool = makeTool({ transform: { mode: 'select', select: { id: '$.id' } } });
    const { executor } = build(tool, { engineResult: file(PDF, 'application/pdf', 'invoice.pdf') });
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'file:///invoice.pdf', mimeType: 'application/pdf', blob: PDF.toString('base64') },
    });
    expect(JSON.parse(res.content[0].text).file.filename).toBe('invoice.pdf');
  });

  it('renders a cached binary body the same way', async () => {
    const cached = JSON.stringify(file(JPEG, 'image/jpeg'));
    const { executor } = build(makeTool({ cacheTtl: 60 }), { cached });
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });
});

describe('DynamicMcpTools: the connector id reaches the engine', () => {
  function bridgeTool(authConfig: Record<string, unknown>): RegisteredTool {
    return {
      id: 'tool-c',
      connectorId: 'cmv-cloudinary',
      organizationId: 'org-1',
      name: 'cloudinary_list_images',
      description: 'List images',
      parameters: { type: 'object', properties: {} },
      connectorType: 'MCP',
      connectorConfig: {
        baseUrl: 'https://asset-management.mcp.cloudinary.com/mcp',
        authType: 'OAUTH2',
        // The registry holds the decrypted authConfig as a JSON string.
        authConfig: JSON.stringify(authConfig),
      },
      endpointMapping: { method: 'list-images', path: '/mcp' },
    };
  }

  function run(tool: RegisteredTool) {
    const mcpClientEngine = { execute: jest.fn().mockResolvedValue({ content: [] }) };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mcpClientEngine as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
    );
    return { executor, mcpClientEngine };
  }

  // Without it the OAuth2 token service could neither cache a renewed token
  // nor store the rotated refresh token, and the next renewal replayed the
  // spent one (Cloudinary: invalid_grant minutes after each authorization).
  it('passes the connector id, so OAuth2 renewals are cached, locked and stored', async () => {
    const { executor, mcpClientEngine } = run(
      bridgeTool({ tokenUrl: 'https://x/token', accessToken: 'at', refreshToken: 'rt' }),
    );
    await executor.executeTool('cloudinary_list_images', {});
    expect(mcpClientEngine.execute.mock.calls[0][0]).toMatchObject({
      connectorId: 'cmv-cloudinary',
      authType: 'OAUTH2',
    });
  });

  it('leaves credentials that depend on the caller ({{amcp.*}}) unkeyed', async () => {
    const { executor, mcpClientEngine } = run(
      bridgeTool({ tokenUrl: 'https://x/token', username: '{{amcp.user_email}}', password: 'p' }),
    );
    await executor.executeTool('cloudinary_list_images', {});
    expect(mcpClientEngine.execute.mock.calls[0][0].connectorId).toBeUndefined();
  });
});


describe('DynamicMcpTools — MCP tool error envelopes', () => {
  const CONTEXT = {
    organizationId: 'org-1', userId: 'user-1', userEmail: 'caller@example.com',
    mcpServerId: 'server-1', mcpServerName: 'Example', authMethod: 'api_key',
    apiKeyName: 'desktop', intent: 'inspect devices', learnable: true,
  };
  const FAILURE = { isError: true, content: [{ type: 'text', text: 'Visible refusal' }] };
  const SAFE_FAILURE = { content: [{ type: 'text', text: 'Visible refusal' }], isError: true };
  const MODE_CACHE = [
    { cloud: false, cacheTtl: undefined }, { cloud: false, cacheTtl: 0 }, { cloud: false, cacheTtl: 300 },
    { cloud: true, cacheTtl: undefined }, { cloud: true, cacheTtl: 0 }, { cloud: true, cacheTtl: 300 },
  ];

  function mcpTool(responseMapping?: Record<string, unknown>): RegisteredTool {
    return { ...makeTool(responseMapping), connectorType: 'MCP', useProxy: false,
      endpointMapping: { method: 'remote_list_devices', path: '/mcp' } };
  }

  function statefulCache(built: ReturnType<typeof build>) {
    const entries = new Map<string, string>();
    built.redis.get.mockImplementation(async (key: string) => entries.get(key) ?? null);
    built.redis.set.mockImplementation(async (key: string, value: string) => { entries.set(key, value); });
    return entries;
  }

  function refusal(cloud = false, cacheTtl?: number) {
    const built = build(mcpTool({ cacheTtl }), { engineResult: FAILURE, cloud });
    statefulCache(built);
    return built;
  }

  function call(built: ReturnType<typeof build>) {
    return built.executor.executeTool('list_devices', { page: 1 }, CONTEXT);
  }

  function errorMetric() {
    return expect.objectContaining({ connectorType: 'MCP', connectorId: 'conn-1', tool: 'list_devices',
      status: 'error', durationMs: expect.any(Number), upstreamStatus: undefined });
  }

  function errorAudit() {
    return expect.objectContaining({ toolId: 'tool-1', connectorId: 'conn-1', userId: CONTEXT.userId,
      userEmail: CONTEXT.userEmail, organizationId: CONTEXT.organizationId, mcpServerId: CONTEXT.mcpServerId,
      usedProxy: false, intent: CONTEXT.intent, learnable: true, input: { page: 1 }, status: 'ERROR',
      output: SAFE_FAILURE, durationMs: expect.any(Number),
      error: 'MCP tool returned isError: true: body=Visible refusal',
      clientInfo: JSON.stringify({ authMethod: 'api_key', apiKeyName: 'desktop', userEmail: CONTEXT.userEmail, mcpServerName: 'Example' }) });
  }

  function capturedLogs() {
    return [...jest.mocked(Logger.prototype.log).mock.calls, ...jest.mocked(Logger.prototype.warn).mock.calls];
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    jest.spyOn(metrics, 'recordToolCall');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(processGauges, 'inc');
    jest.spyOn(processGauges, 'dec');
  });
  afterEach(() => jest.restoreAllMocks());

  it('sets the outer isError flag for a resolved MCP tool failure', async () => {
    expect((await call(refusal())).isError).toBe(true);
  });

  it('projects client text instead of serializing the upstream envelope', async () => {
    expect((await call(refusal())).content).toEqual(SAFE_FAILURE.content);
  });

  it('records an ERROR audit instead of a SUCCESS audit', async () => {
    const built = refusal();
    await call(built);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(errorAudit());
  });

  it('records an ERROR metric instead of a SUCCESS metric', async () => {
    await call(refusal());
    expect(metrics.recordToolCall).toHaveBeenCalledWith(errorMetric());
  });

  it('does not write failed responses to the response cache', async () => {
    const built = refusal(false, 300);
    await call(built);
    expect(built.redis.set).not.toHaveBeenCalled();
  });

  it('reaches the remote engine again for an identical failed invocation', async () => {
    const built = refusal(false, 300);
    await call(built);
    await call(built);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(2);
  });

  it('does not schedule knowledge graph ingestion for failed responses', async () => {
    const built = refusal();
    await call(built);
    expect(built.kg.scheduleObservationalIngest).not.toHaveBeenCalled();
  });

  it.each(MODE_CACHE)('keeps returned errors out of success paths (cloud=$cloud, ttl=$cacheTtl)', async ({ cloud, cacheTtl }) => {
    const built = refusal(cloud, cacheTtl);
    expect(await call(built)).toEqual(SAFE_FAILURE);
    expect(await call(built)).toEqual(SAFE_FAILURE);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(2);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 'conn-1' }),
      expect.objectContaining({ method: 'remote_list_devices' }), { page: 1 });
    expect(built.restEngine.execute).not.toHaveBeenCalled();
    expect(built.license.checkLicenseActive.mock.calls).toEqual([['org-1'], ['org-1']]);
    expect(built.redis.get).toHaveBeenCalledTimes(cacheTtl ? 2 : 0);
    expect(built.redis.set).not.toHaveBeenCalled();
    expect(built.kg.scheduleObservationalIngest).not.toHaveBeenCalled();
    expect(built.audit.logInvocation.mock.calls).toEqual([[errorAudit()], [errorAudit()]]);
    expect(jest.mocked(metrics.recordToolCall).mock.calls).toEqual([[errorMetric()], [errorMetric()]]);
    expect(capturedLogs()).toEqual([[expect.objectContaining({ msg: 'tool_call', status: 'ERROR',
      resultBytes: 0, upstreamStatus: undefined, organizationId: 'org-1', mcpServerId: 'server-1' })],
      [expect.objectContaining({ msg: 'tool_call', status: 'ERROR', resultBytes: 0, upstreamStatus: undefined })]]);
  });

  it.each([
    { content: [{ type: 'text', text: 'one' }], text: 'one' },
    { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], text: 'first\nsecond' },
    { content: [], text: '' },
    { content: [{ type: 'image', data: 'aA==', mimeType: 'image/png' }], text: '' },
    { content: [{ type: 'image', data: 'aA==', mimeType: 'image/png' }, { type: 'text', text: 'last' }], text: 'last' },
    { content: [{ type: 'text', text: '' }, { type: 'text', text: 'middle' }, { type: 'text', text: '' }], text: '\nmiddle\n' },
    { content: [{ type: 'text', text: 42 }, { type: 'text', text: null }, { type: 'text', text: 'valid' }], text: 'valid' },
    { content: [null, false, { text: 'untyped' }, { type: 'TEXT', text: 'wrong type' }], text: '' },
  ])('returns the ordered string-text projection ($text)', async ({ content, text }) => {
    const tool = mcpTool({ ...SELECT_TRANSFORM, followUp: 'OMIT_FOLLOW_UP', cacheTtl: 300 });
    const upstream = { ...FAILURE, content };
    const original = structuredClone(upstream);
    const built = build(tool, { engineResult: upstream });
    const expected = { content: [{ type: 'text', text }], isError: true };
    expect(await call(built)).toEqual(expected);
    expect(built.audit.logInvocation.mock.calls[0][0].output).toEqual(expected);
    expect(upstream).toEqual(original);
    expect(built.redis.set).not.toHaveBeenCalled();
  });

  it('omits envelope metadata, text annotations and every non-text field from all observations', async () => {
    const sentinels = ['OMIT_META', 'OMIT_STRUCTURED', 'OMIT_VENDOR', 'OMIT_TEXT_META', '2099-01-01T00:00:00Z',
      'OMIT_IMAGE', 'OMIT_AUDIO', 'OMIT_RESOURCE', 'OMIT_RESOURCE_LINK'];
    const envelope = { isError: true, _meta: { marker: sentinels[0] }, structuredContent: { marker: sentinels[1] },
      vendor: sentinels[2], content: [
        { type: 'image', data: sentinels[5], mimeType: 'image/png' },
        { type: 'audio', data: sentinels[6], mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'proof://resource', text: sentinels[7] } },
        { type: 'resource_link', uri: 'https://example.com/resource', name: sentinels[8] },
        { type: 'text', text: 'Visible refusal', _meta: { marker: sentinels[3] },
          annotations: { audience: ['assistant'], lastModified: sentinels[4] } },
      ] };
    const original = structuredClone(envelope);
    const built = build(mcpTool(), { engineResult: envelope });
    const result = await call(built);
    expect(result).toEqual(SAFE_FAILURE);
    expect(built.audit.logInvocation.mock.calls[0][0].output).toEqual(SAFE_FAILURE);
    expect(built.audit.logInvocation.mock.calls[0][0].error).toBe('MCP tool returned isError: true: body=Visible refusal');
    const observations = JSON.stringify({ result, audits: built.audit.logInvocation.mock.calls, logs: capturedLogs() });
    for (const sentinel of sentinels) expect(observations).not.toContain(sentinel);
    expect(envelope).toEqual(original);
  });

  it('redacts projected explicit, numeric and patterned secrets without mutating the fixture', async () => {
    const secrets = ['opaque-value-1122', '87654321', 'sk_live_1234567890AbCdEf'];
    const envelope = { isError: true, content: [{ type: 'text', text: secrets.join(' ') }] };
    const original = structuredClone(envelope);
    const tool = mcpTool();
    tool.connectorConfig.envVars = { API_KEY: secrets[0], PIN_SECRET: secrets[1] };
    const built = build(tool, { engineResult: envelope });
    const result = await call(built);
    expect(result).toEqual({ content: [{ type: 'text', text: '[REDACTED] [REDACTED] [REDACTED]' }], isError: true });
    expect(built.audit.logInvocation.mock.calls[0][0].output).toEqual(result);
    expect(built.audit.logInvocation.mock.calls[0][0].error).toBe('MCP tool returned isError: true: body=[REDACTED] [REDACTED] [REDACTED]');
    const observations = JSON.stringify({ result, audits: built.audit.logInvocation.mock.calls, logs: capturedLogs() });
    for (const secret of secrets) expect(observations).not.toContain(secret);
    expect(envelope).toEqual(original);
  });

  it('lets error then success then cache hit retain ordinary MCP success bytes', async () => {
    const success = { content: [{ type: 'text', text: 'ok' }] };
    const built = refusal(false, 300);
    built.mcpClientEngine.execute.mockResolvedValueOnce(FAILURE).mockResolvedValueOnce(success);
    expect(await call(built)).toEqual(SAFE_FAILURE);
    expect(built.redis.set).not.toHaveBeenCalled();
    const expected = { content: [{ type: 'text', text: JSON.stringify(success, null, 2) }], structured: success };
    expect(await call(built)).toEqual(expected);
    expect(await call(built)).toEqual(expected);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(2);
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation.mock.calls.map(([row]) => row.status)).toEqual(['ERROR', 'SUCCESS']);
    expect(jest.mocked(metrics.recordToolCall).mock.calls.map(([row]) => row.status)).toEqual(['error', 'success']);
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it('preserves successful MCP mapping, followUp, structured data and success cache reads', async () => {
    const tool = mcpTool({ ...SELECT_TRANSFORM, followUp: 'now call get_device', cacheTtl: 300 });
    const built = build(tool, { engineResult: RAW });
    statefulCache(built);
    const expected = { content: [{ type: 'text', text: JSON.stringify(MAPPED, null, 2) +
      '\n\n---\nWORKFLOW HINT (guidance for the assistant, not part of the API response): now call get_device' }], structured: MAPPED };
    expect(await call(built)).toEqual(expected);
    expect(await call(built)).toEqual(expected);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(built.redis.set.mock.calls[0][1])).toEqual(RAW);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS', output: RAW }));
  });

  it.each([
    { content: [{ type: 'text', text: 'ok' }] },
    { isError: false, content: [] }, { isError: 'true', content: [] }, { isError: 1, content: [] },
    { content: [{ type: 'text', text: '{"isError":true}' }], nested: { isError: true } },
    { isError: true, content: null }, { isError: true, content: 'not an array' },
    null, false, 42, 'plain text', [{ isError: true, content: [] }],
  ])('keeps non-error and non-envelope MCP bodies on the existing success path (%j)', async (body) => {
    const built = refusal(false, 300);
    built.mcpClientEngine.execute.mockResolvedValue(body);
    const expected = { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structured: body };
    expect(await call(built)).toEqual(expected);
    expect(await call(built)).toEqual(expected);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(1);
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS', output: body }));
    expect(metrics.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it.each(['REST', 'GRAPHQL', 'SOAP', 'DATABASE', 'ODATA'] as const)('keeps %s envelope-shaped business data successful and cacheable', async (connectorType) => {
    const tool = { ...makeTool({ cacheTtl: 300 }), connectorType };
    const built = build(tool, { engineResult: FAILURE });
    const engine = built.engines[connectorType];
    engine.execute.mockResolvedValue(FAILURE);
    statefulCache(built);
    const expected = { content: [{ type: 'text', text: JSON.stringify(FAILURE, null, 2) }], structured: FAILURE };
    expect(await call(built)).toEqual(expected);
    expect(await call(built)).toEqual(expected);
    expect(engine.execute).toHaveBeenCalledTimes(1);
    expect(built.mcpClientEngine.execute).not.toHaveBeenCalled();
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS', output: FAILURE }));
    expect(metrics.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it('preserves thrown MCP error details, redaction and ERROR observations', async () => {
    const tool = mcpTool({ cacheTtl: 300 });
    tool.connectorConfig.envVars = { API_KEY: 'opaque-value-1122' };
    const built = build(tool);
    built.mcpClientEngine.execute.mockRejectedValue(new Error('remote opaque-value-1122 unavailable'));
    const result = await call(built);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ error: 'remote [REDACTED] unavailable' }, null, 2) }], isError: true });
    expect(built.audit.logInvocation).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'ERROR', error: 'remote [REDACTED] unavailable' }));
    expect(jest.mocked(metrics.recordToolCall).mock.calls).toEqual([[errorMetric()]]);
    expect(capturedLogs()).toEqual([[expect.objectContaining({ status: 'ERROR', resultBytes: 0, upstreamStatus: undefined })]]);
    expect(built.redis.set).not.toHaveBeenCalled();
    expect(built.kg.scheduleObservationalIngest).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('balances the pending engine gauge before %s audit', async (settlement) => {
    const pending = deferred<unknown>();
    const entered = deferred<void>();
    const built = refusal();
    built.mcpClientEngine.execute.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const result = call(built);
    await entered.promise;
    expect(processGauges.get('toolCallsInFlight')).toBe(1);
    expect(processGauges.inc).toHaveBeenCalledTimes(1);
    expect(processGauges.dec).not.toHaveBeenCalled();
    expect(built.audit.logInvocation).not.toHaveBeenCalled();
    if (settlement === 'resolve') pending.resolve(FAILURE);
    else pending.reject(new Error('remote unavailable'));
    await result;
    expect(processGauges.get('toolCallsInFlight')).toBe(0);
    expect(processGauges.dec).toHaveBeenCalledTimes(1);
    expect(jest.mocked(processGauges.dec).mock.invocationCallOrder[0]).toBeLessThan(built.audit.logInvocation.mock.invocationCallOrder[0]);
  });

  it('does not increment the engine gauge on a cache hit', async () => {
    const built = build(mcpTool({ cacheTtl: 300 }), { cached: JSON.stringify(RAW) });
    await call(built);
    expect(processGauges.inc).not.toHaveBeenCalled();
    expect(processGauges.dec).not.toHaveBeenCalled();
    expect(built.mcpClientEngine.execute).not.toHaveBeenCalled();
  });

  it('does not increment the engine gauge when preparation fails', async () => {
    const tool = mcpTool();
    tool.setupStatus = 'needs_authorization';
    const built = build(tool);
    expect((await call(built)).isError).toBe(true);
    expect(processGauges.inc).not.toHaveBeenCalled();
    expect(processGauges.dec).not.toHaveBeenCalled();
    expect(built.mcpClientEngine.execute).not.toHaveBeenCalled();
  });
});

describe('DynamicMcpTools — the size limit on the rendered result', () => {
  const PAYLOAD = {
    items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `device-${i}`, tags: ['a', 'b'] })),
  };
  const PRETTY = JSON.stringify(PAYLOAD, null, 2);
  const COMPACT = JSON.stringify(PAYLOAD);
  let saved: string | undefined;

  function setLimit(bytes: number) {
    process.env.TOOL_MAX_RESPONSE_BYTES = String(bytes);
  }

  function expectTooLarge(res: Awaited<ReturnType<DynamicMcpTools['executeTool']>>) {
    expect(res.isError).toBe(true);
    expect(res.structured).toBeUndefined();
    expect(res.content).toHaveLength(1);
    const detail = JSON.parse(res.content[0].text);
    expect(detail.code).toBe('TOOL_RESPONSE_TOO_LARGE');
    expect(detail.error).toMatch(/^The tool result is larger than .*, the limit for one tool call/);
    expect(detail.error).toMatch(/Narrow the request/);
    expect(detail.error).toMatch(/TOOL_MAX_RESPONSE_BYTES/);
  }

  beforeEach(() => {
    saved = process.env.TOOL_MAX_RESPONSE_BYTES;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TOOL_MAX_RESPONSE_BYTES;
    else process.env.TOOL_MAX_RESPONSE_BYTES = saved;
    jest.restoreAllMocks();
  });

  it('leaves a result under the limit untouched (pretty-printed)', async () => {
    setLimit(PRETTY.length);
    const { executor, audit } = build(makeTool(), { engineResult: PAYLOAD });
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(PRETTY);
    expect(res.structured).toEqual(PAYLOAD);
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCESS', output: PAYLOAD }),
    );
  });

  it('sends compact JSON when only the indentation puts the result over the limit', async () => {
    setLimit(COMPACT.length);
    const { executor, audit } = build(makeTool(), { engineResult: PAYLOAD });
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(COMPACT);
    expect(res.structured).toEqual(PAYLOAD);
    expect(audit.logInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('keeps the workflow hint in the compact text and counts it', async () => {
    const followUp = 'now call get_device';
    const hint = `\n\n---\nWORKFLOW HINT (guidance for the assistant, not part of the API response): ${followUp}`;
    setLimit(COMPACT.length + hint.length);
    const { executor } = build(makeTool({ followUp }), { engineResult: PAYLOAD });
    const res = await executor.executeTool('list_devices', {});
    expect(res.content[0].text).toBe(COMPACT + hint);

    setLimit(COMPACT.length + hint.length - 1);
    expectTooLarge(
      await build(makeTool({ followUp }), { engineResult: PAYLOAD }).executor.executeTool('list_devices', {}),
    );
  });

  it('returns the TOOL_RESPONSE_TOO_LARGE error when even compact JSON is over the limit', async () => {
    setLimit(COMPACT.length - 1);
    const { executor, audit, redis } = build(makeTool({ cacheTtl: 300 }), { engineResult: PAYLOAD });
    const res = await executor.executeTool('list_devices', {});
    expectTooLarge(res);
    // Logged as the error the client got, without the payload; not cached.
    const row = audit.logInvocation.mock.calls[0][0];
    expect(row.status).toBe('ERROR');
    expect(row.output).toBeUndefined();
    expect(row.error).toMatch(/^The tool result is larger than/);
    expect(redis.set).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'tool_result_too_large', toolName: 'list_devices' }),
    );
  });

  it('counts bytes, not characters, and does not re-serialize a plain string', async () => {
    const text = 'é'.repeat(100); // 100 characters, 202 bytes with the quotes
    setLimit(150);
    const { executor } = build(makeTool(), { engineResult: text });
    const stringify = jest.spyOn(JSON, 'stringify');
    const res = await executor.executeTool('list_devices', {});
    expectTooLarge(res);
    expect(stringify.mock.calls.filter(([v]) => v === text)).toHaveLength(1);
  });

  it.each(['DATABASE', 'MCP', 'GRAPHQL', 'SOAP'])(
    'applies to %s connectors, whatever their engine read',
    async (connectorType) => {
      setLimit(COMPACT.length - 1);
      const tool = {
        ...makeTool(),
        connectorType,
        useProxy: false,
        endpointMapping: { method: 'GET', path: '/devices' },
      } as RegisteredTool;
      const built = build(tool);
      const engine = built.engines[connectorType as keyof typeof built.engines];
      engine.execute.mockResolvedValue(PAYLOAD);
      const res = await built.executor.executeTool('list_devices', {});
      expect(engine.execute).toHaveBeenCalled();
      expectTooLarge(res);
    },
  );

  it('applies to a result read back from the response cache', async () => {
    setLimit(COMPACT.length - 1);
    const { executor, restEngine } = build(makeTool({ cacheTtl: 300 }), {
      cached: JSON.stringify(PAYLOAD),
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).not.toHaveBeenCalled();
    expectTooLarge(res);
  });

  it('uses the 10 MB default when TOOL_MAX_RESPONSE_BYTES is unset', async () => {
    delete process.env.TOOL_MAX_RESPONSE_BYTES;
    const big = { blob: 'x'.repeat(10 * 1024 * 1024) };
    const { executor } = build(makeTool(), { engineResult: big });
    expectTooLarge(await executor.executeTool('list_devices', {}));
  });
});
