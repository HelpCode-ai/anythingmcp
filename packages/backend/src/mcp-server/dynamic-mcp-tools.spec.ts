import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { Logger } from '@nestjs/common';
import * as metrics from '../common/metrics';

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
  const restEngine = {
    execute: jest.fn().mockResolvedValue(opts.engineResult ?? RAW),
  };
  const mcpClientEngine = { execute: jest.fn().mockResolvedValue(opts.engineResult ?? RAW) };
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
    {} as any,
    {} as any,
    mcpClientEngine as any,
    {} as any,
    kg as any,
  );
  return { executor, redis, audit, restEngine, mcpClientEngine, kg, license };
}

function firstText(result: Awaited<ReturnType<DynamicMcpTools['executeTool']>>): string {
  const first = result.content[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected the first result block to be text');
  }
  return first.text;
}

describe('DynamicMcpTools — response shaping', () => {
  it('leaves the output byte-identical when no transform is configured', async () => {
    const { executor } = build(makeTool());
    const res = await executor.executeTool('list_devices', {});
    expect(firstText(res)).toBe(JSON.stringify(RAW, null, 2));
    expect(res.isError).toBeUndefined();
  });

  it('is a no-op when responseMapping only carries cacheTtl / followUp', async () => {
    const { executor } = build(makeTool({ cacheTtl: 0, followUp: undefined }));
    const res = await executor.executeTool('list_devices', {});
    expect(firstText(res)).toBe(JSON.stringify(RAW, null, 2));
  });

  it('applies a configured transform to the text and to structuredContent', async () => {
    const { executor } = build(makeTool(SELECT_TRANSFORM));
    const res = await executor.executeTool('list_devices', {});
    expect(JSON.parse(firstText(res))).toEqual(MAPPED);
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
    expect(JSON.parse(firstText(res))).toEqual(MAPPED);
  });

  it('appends the workflow hint after the mapped payload, and keeps structuredContent parseable', async () => {
    const { executor } = build(makeTool({ ...SELECT_TRANSFORM, followUp: 'now call get_device' }));
    const res = await executor.executeTool('list_devices', {});
    expect(firstText(res)).toContain('WORKFLOW HINT');
    expect(firstText(res).startsWith(JSON.stringify(MAPPED, null, 2))).toBe(true);
    // The whole text is no longer valid JSON — this is exactly why the
    // executor hands back `structured` instead of making callers re-parse it.
    expect(() => JSON.parse(firstText(res))).toThrow();
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
    expect(JSON.parse(firstText(res))).toEqual(RAW);
  });

  it('surfaces the error instead when fallbackToRaw is false', async () => {
    const { executor } = build(
      makeTool({ transform: { fallbackToRaw: false, select: { bad: 'a[' } } }),
    );
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(firstText(res)).error).toMatch(/Response mapping failed/);
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
    const detail = JSON.parse(firstText(res));
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
    expect(JSON.parse(firstText(res)).hint).toBe(hint);
  });

  it('adds no hint for an ordinary failure on an unknown host', async () => {
    const { executor, restEngine } = build(makeTool());
    restEngine.execute.mockRejectedValueOnce(new Error('boom'));
    const res = await executor.executeTool('list_devices', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(firstText(res)).hint).toBeUndefined();
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
    expect(JSON.parse(firstText(res))).toEqual(MAPPED);
    expect(res.structured).toEqual(MAPPED);
  });

  it('re-executes rather than serving an unparsable cache entry', async () => {
    const { executor, restEngine } = build(makeTool({ cacheTtl: 300 }), {
      cached: 'not json{',
    });
    const res = await executor.executeTool('list_devices', {});
    expect(restEngine.execute).toHaveBeenCalled();
    expect(JSON.parse(firstText(res))).toEqual(RAW);
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
    expect(firstText(res)).toContain('not found');
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
    expect(JSON.parse(firstText(res))._pagination.nextCursor).toBe('abc');
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
      const text = firstText(res);
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
    expect(firstText(res)).not.toContain(PNG);
    expect(JSON.parse(firstText(res)).data[0].b64_json).toMatch(/^\[image 1: image\/png/);
    expect(res.content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(JSON.stringify(res.structured)).not.toContain(PNG);
    expect(audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS' }));
  });

  it('adds no image content for tools without the option, even when the body holds base64', async () => {
    const { executor } = build(makeTool(), { engineResult: GENERATED });
    const res = await executor.executeTool('list_devices', {});
    expect(res.content).toHaveLength(1);
    expect(firstText(res)).toBe(JSON.stringify(GENERATED, null, 2));
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
    expect(firstText(res)).not.toContain(JPEG.toString('base64'));
    expect(JSON.parse(firstText(res)).file).toMatchObject({ contentType: 'application/octet-stream', bytes: JPEG.length });
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
    expect(JSON.parse(firstText(res)).file.filename).toBe('invoice.pdf');
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
  const FAILURE = {
    isError: true,
    content: [
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', annotations: { audience: ['user'], priority: 0.5 } },
      { type: 'text', text: 'The remote tool refused the request.', annotations: { audience: ['assistant'] } },
      { type: 'resource', resource: { uri: 'https://api.example.com/problem', mimeType: 'text/plain', text: 'details' } },
    ],
    _meta: { requestId: 'request-1' },
    structuredContent: { reason: 'invalid_input' },
    vendor: { retryable: false },
  };
  const CONTEXT = {
    organizationId: 'org-1', userId: 'user-1', userEmail: 'caller@example.com',
    mcpServerId: 'server-1', mcpServerName: 'Example', authMethod: 'api_key',
    apiKeyName: 'desktop', intent: 'inspect devices', learnable: true,
  };

  function mcpTool(responseMapping?: Record<string, unknown>): RegisteredTool {
    return {
      ...makeTool(responseMapping),
      connectorType: 'MCP',
      useProxy: false,
      endpointMapping: { method: 'remote_list_devices', path: '/mcp' },
    };
  }

  function statefulCache(built: ReturnType<typeof build>) {
    const entries = new Map<string, string>();
    built.redis.get.mockImplementation(async (key: string) => entries.get(key) ?? null);
    built.redis.set.mockImplementation(async (key: string, value: string) => { entries.set(key, value); });
    return entries;
  }

  function failedObservations(built: ReturnType<typeof build>, results: unknown[]) {
    return {
      results,
      remoteCalls: built.mcpClientEngine.execute.mock.calls.length,
      audits: built.audit.logInvocation.mock.calls,
      cacheWrites: built.redis.set.mock.calls,
      kgCalls: built.kg.scheduleObservationalIngest.mock.calls,
      metrics: jest.mocked(metrics.recordToolCall).mock.calls,
    };
  }

  beforeEach(() => {
    jest.spyOn(metrics, 'recordToolCall');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { cloud: false, cacheTtl: undefined },
    { cloud: false, cacheTtl: 300 },
    { cloud: true, cacheTtl: undefined },
    { cloud: true, cacheTtl: 300 },
  ])('keeps remote failures out of success paths (cloud=$cloud, ttl=$cacheTtl)', async ({ cloud, cacheTtl }) => {
    const built = build(mcpTool({ cacheTtl }), { engineResult: FAILURE, cloud });
    statefulCache(built);
    const results = [
      await built.executor.executeTool('list_devices', { page: 1 }, CONTEXT),
      await built.executor.executeTool('list_devices', { page: 1 }, CONTEXT),
    ];
    const audit = expect.objectContaining({
      toolId: 'tool-1', connectorId: 'conn-1', userId: CONTEXT.userId,
      userEmail: CONTEXT.userEmail, organizationId: CONTEXT.organizationId,
      mcpServerId: CONTEXT.mcpServerId, usedProxy: false, intent: CONTEXT.intent,
      learnable: true, input: { page: 1 }, status: 'ERROR',
      output: FAILURE, durationMs: expect.any(Number), error: expect.stringContaining('invalid_input'),
      clientInfo: JSON.stringify({ authMethod: 'api_key', apiKeyName: 'desktop', userEmail: CONTEXT.userEmail, mcpServerName: 'Example' }),
    });
    const metric = expect.objectContaining({
      connectorType: 'MCP', connectorId: 'conn-1', tool: 'list_devices',
      status: 'error', durationMs: expect.any(Number), upstreamStatus: undefined,
    });
    expect(failedObservations(built, results)).toEqual({
      results: [FAILURE, FAILURE], remoteCalls: 2, audits: [[audit], [audit]],
      cacheWrites: [], kgCalls: [], metrics: [[metric], [metric]],
    });
    expect(built.redis.get).toHaveBeenCalledTimes(cacheTtl ? 2 : 0);
    expect(built.license.checkLicenseActive).toHaveBeenNthCalledWith(1, 'org-1');
    expect(built.mcpClientEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'conn-1' }),
      expect.objectContaining({ method: 'remote_list_devices' }), { page: 1 },
    );
    expect(built.restEngine.execute).not.toHaveBeenCalled();
    expect(Logger.prototype.log).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'tool_call', status: 'ERROR', upstreamStatus: undefined,
      organizationId: 'org-1', mcpServerId: 'server-1', authMethod: 'api_key',
    }));
  });

  it.each([{ content: [] }, { content: FAILURE.content }])('preserves empty or non-text-first content despite transform/followUp (%j)', async ({ content }) => {
    const envelope = { ...FAILURE, content };
    const built = build(mcpTool({
      ...SELECT_TRANSFORM, followUp: 'now call get_device', cacheTtl: 300,
    }), { engineResult: envelope });
    const original = structuredClone(envelope);
    const result = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(result).toEqual(envelope);
    expect(envelope).toEqual(original);
    expect(built.redis.set).not.toHaveBeenCalled();
    expect(built.kg.scheduleObservationalIngest).not.toHaveBeenCalled();
  });

  it('redacts explicit and numeric secrets and secret patterns without mutating the engine fixture', async () => {
    const secrets = ['opaque-value-1122', '87654321', 'sk_live_1234567890AbCdEf'];
    const envelope = {
      ...FAILURE, content: [{ type: 'text', text: secrets.join(' ') }],
      structuredContent: { explicit: secrets[0], numeric: secrets[1], pattern: secrets[2] },
      _meta: { detail: secrets.join(' ') },
    };
    const original = structuredClone(envelope);
    const tool = mcpTool();
    tool.connectorConfig.envVars = { API_KEY: secrets[0], PIN_SECRET: secrets[1] };
    const built = build(tool, { engineResult: envelope });
    const result = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(result).toEqual({
      ...FAILURE, content: [{ type: 'text', text: '[REDACTED] [REDACTED] [REDACTED]' }],
      structuredContent: { explicit: '[REDACTED]', numeric: '[REDACTED]', pattern: '[REDACTED]' },
      _meta: { detail: '[REDACTED] [REDACTED] [REDACTED]' },
    });
    const row = built.audit.logInvocation.mock.calls[0][0];
    expect(row.output).toEqual(result);
    expect(row.error).toContain('[REDACTED]');
    for (const secret of secrets) expect(JSON.stringify(row)).not.toContain(secret);
    expect(envelope).toEqual(original);
  });

  it('lets a later success reach the remote tool and cache normally', async () => {
    const success = { content: [{ type: 'text', text: 'ok' }] };
    const built = build(mcpTool({ cacheTtl: 300 }), { engineResult: FAILURE });
    const entries = statefulCache(built);
    built.mcpClientEngine.execute.mockResolvedValueOnce(FAILURE).mockResolvedValueOnce(success);
    expect(await built.executor.executeTool('list_devices', {}, CONTEXT)).toEqual(FAILURE);
    expect(entries.size).toBe(0);
    expect(built.redis.set).not.toHaveBeenCalled();
    const second = await built.executor.executeTool('list_devices', {}, CONTEXT);
    const third = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(second.isError).toBeUndefined();
    expect(second.structured).toEqual(success);
    expect(third).toEqual(second);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(2);
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation.mock.calls.map(([row]) => row.status)).toEqual(['ERROR', 'SUCCESS']);
    expect(jest.mocked(metrics.recordToolCall).mock.calls.map(([row]) => row.status)).toEqual(['error', 'success']);
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it('keeps envelope-shaped REST business data successful and cacheable', async () => {
    const built = build(makeTool({ cacheTtl: 300 }), { engineResult: FAILURE });
    statefulCache(built);
    const first = await built.executor.executeTool('list_devices', {}, CONTEXT);
    const second = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(first.isError).toBeUndefined();
    expect(first.structured).toEqual(FAILURE);
    expect(second).toEqual(first);
    expect(built.restEngine.execute).toHaveBeenCalledTimes(1);
    expect(built.mcpClientEngine.execute).not.toHaveBeenCalled();
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS', output: FAILURE }));
    expect(metrics.recordToolCall).toHaveBeenCalledTimes(1);
    expect(metrics.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, 'true', 1])('only treats a strict top-level true flag as failure (%j)', async (isError) => {
    const envelope = { isError, content: [{ type: 'text', text: '{"isError":true}' }], nested: { isError: true } };
    const built = build(mcpTool({ cacheTtl: 300 }), { engineResult: envelope });
    statefulCache(built);
    const first = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(first.isError).toBeUndefined();
    expect(first.structured).toEqual(envelope);
    expect(await built.executor.executeTool('list_devices', {}, CONTEXT)).toEqual(first);
    expect(built.mcpClientEngine.execute).toHaveBeenCalledTimes(1);
    expect(built.redis.set).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS' }));
    expect(metrics.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(built.kg.scheduleObservationalIngest).toHaveBeenCalledTimes(1);
  });

  it('preserves thrown MCP errors and their audit and metric behavior', async () => {
    const built = build(mcpTool({ cacheTtl: 300 }));
    statefulCache(built);
    built.mcpClientEngine.execute.mockRejectedValue(new Error('remote unavailable'));
    const result = await built.executor.executeTool('list_devices', {}, CONTEXT);
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toEqual({ error: 'remote unavailable' });
    expect(built.audit.logInvocation).toHaveBeenCalledTimes(1);
    expect(built.audit.logInvocation).toHaveBeenCalledWith(expect.objectContaining({ status: 'ERROR', error: 'remote unavailable' }));
    expect(metrics.recordToolCall).toHaveBeenCalledTimes(1);
    expect(metrics.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', upstreamStatus: undefined }));
    expect(built.redis.set).not.toHaveBeenCalled();
    expect(built.kg.scheduleObservationalIngest).not.toHaveBeenCalled();
  });
});
