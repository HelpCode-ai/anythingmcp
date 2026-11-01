import * as adapter from './pipefy.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  tools: Array<{
    name: string;
    parameters: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: Record<string, unknown>;
  }>;
};

const toolNames = a.tools.map((t) => t.name);
const byName = (n: string) => a.tools.find((t) => t.name === n)!;

describe('pipefy adapter — static spec conformance', () => {
  it('talks to the Pipefy GraphQL endpoint', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.pipefy.com/graphql');
  });

  it('sends the token as a bearer token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{PIPEFY_API_TOKEN}}');
  });

  it('declares the token env var', () => {
    expect(a.requiredEnvVars).toEqual(['PIPEFY_API_TOKEN']);
  });

  it('probes with the lightest official query', () => {
    // organizations is the lightest documented query and doubles as the auth check.
    expect(a.probe?.tool).toBe('pipefy_list_organizations');
    const tool = byName('pipefy_list_organizations');
    expect(tool.endpointMapping.method).toBe('query');
    expect(String(tool.endpointMapping.path)).toContain('organizations');
    expect(tool.parameters.required ?? []).toEqual([]);
  });

  it('is read-only: every tool is a GraphQL query, no mutations', () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'query')).toBe(true);
  });

  it('passes ids as GraphQL ID variables mapped from tool params', () => {
    for (const name of [
      'pipefy_list_pipes',
      'pipefy_get_pipe',
      'pipefy_get_card',
      'pipefy_get_phase',
    ]) {
      const tool = byName(name);
      const qp = tool.endpointMapping.queryParams as Record<string, string>;
      expect(Object.keys(qp).length).toBeGreaterThan(0);
      // Every mapped value must reference a declared tool parameter.
      for (const v of Object.values(qp)) {
        const m = /^\$(\w+)$/.exec(v);
        expect(m).toBeTruthy();
        expect(Object.keys(tool.parameters.properties ?? {})).toContain(m![1]);
      }
    }
  });

  it('caps list_cards page size at the 50 Pipefy returns per request', () => {
    const tool = byName('pipefy_list_cards');
    const props = tool.parameters.properties as Record<string, { maximum?: number }>;
    expect(props.first.maximum).toBe(50);
    expect(tool.parameters.required).toEqual(['pipe_id']);
  });

  it('pages cards with first/after and exposes pageInfo', () => {
    const tool = byName('pipefy_list_cards');
    const path = String(tool.endpointMapping.path);
    expect(path).toContain('$after: String');
    expect(path).toContain('pageInfo { hasNextPage endCursor }');
  });

  it('every tool name carries the pipefy_ prefix', () => {
    expect(toolNames.every((n) => n.startsWith('pipefy_'))).toBe(true);
  });
});

// Opt-in live check. Needs a real token; skipped in CI by design.
const live =
  process.env.RUN_PIPEFY_LIVE === '1' && process.env.PIPEFY_API_TOKEN
    ? describe
    : describe.skip;
live('pipefy — live (read-only)', () => {
  it('lists organizations through the real GraphQL API', async () => {
    const res = await fetch(a.connector.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PIPEFY_API_TOKEN}`,
      },
      body: JSON.stringify({ query: '{ organizations { id name } }' }),
    });
    const json = (await res.json()) as {
      data?: { organizations?: unknown };
    };
    expect(Array.isArray(json.data?.organizations)).toBe(true);
  }, 60_000);
});
