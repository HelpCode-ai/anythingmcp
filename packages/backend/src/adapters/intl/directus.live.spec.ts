import * as adapter from './directus.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

type Tool = {
  name: string;
  description: string;
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, string>;
  };
  responseMapping?: Record<string, unknown>;
};

const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: {
      token: string;
    };
  };
  probe: {
    tool: string;
  };
  tools: Tool[];
};

describe('directus adapter — static spec conformance', () => {
  it('documents Directus schema and collection permission behavior', () => {
  expect(a.instructions).toContain('directus_fields');
  expect(a.instructions).toContain('HTTP 403');
  expect(a.instructions).toMatch(/does not prove.*collection is absent/i);
});
  it('requires the Directus URL and static token', () => {
    expect(a.requiredEnvVars).toEqual([
      'DIRECTUS_URL',
      'DIRECTUS_TOKEN',
    ]);
  });

  it('uses the self-hosted URL and Bearer authentication', () => {
    expect(a.connector.baseUrl).toBe('{{DIRECTUS_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{DIRECTUS_TOKEN}}');
  });

  it('uses server info as the probe', () => {
    expect(a.probe.tool).toBe('directus_server_info');
  });

  it('documents the SSRF allowlist requirement', () => {
    expect(a.instructions).toContain('SSRF_ALLOWED_HOSTS');
  });

  it('publishes exactly the five requested tools', () => {
    expect(a.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'directus_get_item',
        'directus_list_collections',
        'directus_list_fields',
        'directus_list_items',
        'directus_server_info',
      ].sort(),
    );
  });

  it('maps the five requested Directus endpoints', () => {
    const endpoints = a.tools
      .map(
        (tool) =>
          `${tool.endpointMapping.method} ${tool.endpointMapping.path}`,
      )
      .sort();

    expect(endpoints).toEqual(
      [
        'GET /collections',
        'GET /fields/{collection}',
        'GET /items/{collection}',
        'GET /items/{collection}/{id}',
        'GET /server/info',
      ].sort(),
    );
  });

  it('is read-only', () => {
    for (const tool of a.tools) {
      expect(tool.endpointMapping.method).toBe('GET');
    }
  });

  it('prefixes every tool with directus_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('directus_')).toBe(true);
    }
  });
});

describe('directus adapter — identifiers and paging', () => {
  it('percent-encodes every value it puts in the request path', () => {
    // Sent verbatim, a collection called "../users" would turn
    // /items/{collection} into /users, and a "?" would add query parameters:
    // still read-only, but outside what these tools say they do.
    const withPathParams = a.tools.filter((t) => t.endpointMapping.path.includes('{'));
    expect(withPathParams.map((t) => t.name).sort()).toEqual([
      'directus_get_item',
      'directus_list_fields',
      'directus_list_items',
    ]);
    for (const t of withPathParams) {
      expect(t.endpointMapping.encodePathParams).toBe(true);
    }
  });

  it('keeps meta next to the items when it was asked for, and returns the items alone otherwise', () => {
    const listItems = a.tools.find((t) => t.name === 'directus_list_items')!;
    const items = [{ id: 1, title: 'Hello' }];

    expect(
      applyResponseTransform({ data: items, meta: { total_count: 42 } }, listItems.responseMapping).value,
    ).toEqual({ data: items, meta: { total_count: 42 } });
    expect(applyResponseTransform({ data: items }, listItems.responseMapping).value).toEqual(items);
    expect(applyResponseTransform({ data: [] }, listItems.responseMapping).value).toEqual([]);
  });
});

const runLive =
  process.env.RUN_DIRECTUS_LIVE === '1' &&
  Boolean(process.env.DIRECTUS_URL) &&
  Boolean(process.env.DIRECTUS_TOKEN);

const live = runLive ? describe : describe.skip;

const collection =
  process.env.DIRECTUS_TEST_COLLECTION ?? 'articles';

const itemId =
  process.env.DIRECTUS_TEST_ITEM_ID ?? '1';

live('directus adapter — live API through RestEngine', () => {
  const engine = new RestEngine(
    {} as unknown as OAuth2TokenService,
    {} as unknown as LoginTokenService,
  );

  const config = {
    baseUrl: process.env.DIRECTUS_URL!,
    authType: 'BEARER_TOKEN',
    authConfig: {
      token: process.env.DIRECTUS_TOKEN!,
    },
  };

  function getTool(name: string): Tool {
    const tool = a.tools.find((candidate) => candidate.name === name);

    if (!tool) {
      throw new Error(`Directus tool not found: ${name}`);
    }

    return tool;
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ) {
    const tool = getTool(name);

    return engine.execute(
      config,
      tool.endpointMapping,
      args,
    ) as Promise<{ data?: unknown }>;
  }

  it('gets server information', async () => {
    const response = await callTool(
      'directus_server_info',
      {},
    );

    expect(response.data).toBeDefined();
  }, 30000);

  it('lists collections', async () => {
    const response = await callTool(
      'directus_list_collections',
      {},
    );

    expect(Array.isArray(response.data)).toBe(true);
  }, 30000);

  it('lists fields for the test collection', async () => {
    const response = await callTool(
      'directus_list_fields',
      {
        collection,
      },
    );

    expect(Array.isArray(response.data)).toBe(true);
  }, 30000);

  it('lists items from the test collection', async () => {
    const response = await callTool(
      'directus_list_items',
      {
        collection,
        fields: 'id,title,status',
        limit: 2,
      },
    );

    expect(Array.isArray(response.data)).toBe(true);
  }, 30000);

  it('gets one item by primary key', async () => {
    const response = await callTool(
      'directus_get_item',
      {
        collection,
        id: itemId,
        fields: 'id,title,status',
      },
    );

    expect(response.data).toBeDefined();
  }, 30000);

  it('passes a Directus JSON filter through the real engine', async () => {
    const response = await callTool(
      'directus_list_items',
      {
        collection,
        fields: 'id,title,status',
        filter: JSON.stringify({
          status: {
            _eq: 'published',
          },
        }),
        limit: 10,
      },
    );

    expect(Array.isArray(response.data)).toBe(true);
  }, 30000);

  it('passes an aggregate request through the real engine', async () => {
    const response = await callTool(
      'directus_list_items',
      {
        collection,
        aggregate: JSON.stringify({
        count: '*',
      }),
      },
    );

    expect(Array.isArray(response.data)).toBe(true);
  }, 30000);
});