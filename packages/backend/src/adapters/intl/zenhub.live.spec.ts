import * as adapter from './zenhub.json';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  annotations?: Record<string, boolean>;
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
/** Variables an operation declares: `$name: Type` in its header. */
const declaredVariables = (doc: string) => new Set([...doc.matchAll(/\$([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]));
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

/**
 * Static checks only: the Zenhub GraphQL API needs a personal API key for
 * every request, so there is no keyless live part.
 */
describe('zenhub adapter: static spec conformance', () => {
  it('GraphQL endpoint with a Bearer personal API key', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.zenhub.com/public/graphql');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{ZENHUB_API_KEY}}');
  });

  it('probes with viewer, which needs no arguments', () => {
    expect(a.probe.tool).toBe('zenhub_get_viewer');
    expect(tool('zenhub_get_viewer').parameters.required ?? []).toEqual([]);
  });

  it('does not declare the builtin generic tools the catalog injects', () => {
    const names = a.tools.map((t) => t.name);
    for (const builtin of ['zenhub_graphql_query', 'zenhub_graphql_mutation', 'zenhub_graphql_schema']) {
      expect(names).not.toContain(builtin);
    }
  });

  it('every tool parameter is sent as a declared operation variable', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('zenhub_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const declared = declaredVariables(t.endpointMapping.path);
      const sent = Object.values(t.endpointMapping.queryParams ?? {});
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${sent.includes(`$${p}`)}`).toBe(`${t.name}:true`);
      }
      for (const key of Object.keys(t.endpointMapping.queryParams ?? {})) {
        expect(`${t.name}:${declared.has(key)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('reads are queries and writes are mutations', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method === 'mutation').map((t) => t.name).sort();
    expect(writes).toEqual([
      'zenhub_add_comment',
      'zenhub_add_issues_to_sprints',
      'zenhub_create_issue',
      'zenhub_move_issue',
      'zenhub_set_estimate',
    ]);
    for (const t of a.tools) {
      if (!writes.includes(t.name)) expect(t.endpointMapping.method).toBe('query');
    }
  });

  it('a pipeline search without filters still sends the required filters object', () => {
    const t = tool('zenhub_list_pipeline_issues');
    expect(t.parameters.properties!.filters.default).toEqual({});
    expect(t.endpointMapping.path).toContain('$filters: IssueSearchFiltersInput! = {}');
  });
});
