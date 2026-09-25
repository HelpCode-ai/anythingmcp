import { parse, OperationDefinitionNode, FieldNode } from 'graphql';
import * as adapter from './buffer.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe?: { tool: string };
  connector: { baseUrl: string; type: string; authType: string };
  tools: Array<{
    name: string;
    parameters: { properties?: Record<string, unknown> };
    endpointMapping: {
      method: string;
      path: string;
      queryParams?: Record<string, string>;
      bodyMapping?: unknown;
    };
  }>;
};

/** Root fields each operation selects, e.g. ["account"] or ["createPost"]. */
function rootFields(document: string): string[] {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  return op.selectionSet.selections.map((s) => (s as FieldNode).name.value);
}

describe('buffer adapter — static spec conformance', () => {
  // History: first graphql.buffer.com, which has no DNS record (every call
  // died in the SSRF guard), then api.buffer.com/graphql, which only looked
  // right because Buffer answers 401 on any path before routing. The Quick
  // Start, llms.txt and Buffer's own CLI all use the bare host.
  it('calls the documented endpoint, https://api.buffer.com', () =>
    expect(a.connector.baseUrl).toBe('https://api.buffer.com'));

  it('GraphQL connector with Bearer auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });

  it('proves the key on install with a call that needs no arguments', () =>
    expect(a.probe?.tool).toBe('buffer_current_user'));

  // The previous tools queried currentUser, organization(id:), channel.posts
  // and sendPostNow — none of which exist in Buffer's schema — so even a
  // reachable host would have answered every call with a validation error.
  it('only selects root fields from the documented schema', () => {
    const documented = new Set([
      'account',
      'channels',
      'posts',
      'ideas',
      'createPost',
      'editPost',
      'deletePost',
      'createIdea',
    ]);
    for (const t of a.tools) {
      for (const f of rootFields(t.endpointMapping.path)) {
        expect(`${t.name}:${documented.has(f)}`).toBe(`${t.name}:true`);
      }
    }
  });

  // GraphqlEngine builds `variables` from queryParams (or variablesFromParam).
  // The old tools put them under bodyMapping.variables, which the engine never
  // reads, so every operation went out with `"variables": {}`.
  it('maps every declared variable through queryParams', () => {
    for (const t of a.tools) {
      const em = t.endpointMapping;
      expect(em.bodyMapping).toBeUndefined();
      const op = parse(em.path).definitions[0] as OperationDefinitionNode;
      const declared = (op.variableDefinitions ?? []).map((v) => v.variable.name.value);
      expect(Object.keys(em.queryParams ?? {}).sort()).toEqual([...declared].sort());
      for (const ref of Object.values(em.queryParams ?? {})) {
        expect(Object.keys(t.parameters.properties ?? {})).toContain(ref.slice(1));
      }
    }
  });
});
