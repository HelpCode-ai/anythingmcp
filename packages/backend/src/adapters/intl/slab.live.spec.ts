import { parse, OperationDefinitionNode, FieldNode } from 'graphql';
import * as adapter from './slab.json';

const a = adapter as unknown as {
  probe?: { tool: string };
  connector: { baseUrl: string; type: string; authType: string };
  tools: Array<{
    name: string;
    endpointMapping: { path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
  }>;
};

/** Root fields each operation selects, e.g. ["post"] or ["createPost"]. */
function rootFields(document: string): string[] {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  return op.selectionSet.selections.map((s) => (s as FieldNode).name.value);
}

describe('slab adapter — static spec conformance', () => {
  it('GraphQL endpoint', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.slab.com/v1/graphql');
  });
  it('Bearer auth', () => expect(a.connector.authType).toBe('BEARER_TOKEN'));

  it('checks the token on install with a call that needs no arguments', () =>
    expect(a.probe?.tool).toBe('slab_get_organization'));

  // The previous tools queried me, content(format: MARKDOWN), topics(first:)
  // and postCreate — none of which exist in Slab's published schema
  // (studio.apollographql.com/public/Slab) — and sent their variables under
  // bodyMapping, which the GraphQL engine never reads.
  it('only selects root fields from the published schema', () => {
    const documented = new Set(['organization', 'post', 'search', 'topic', 'createPost']);
    for (const t of a.tools) {
      for (const f of rootFields(t.endpointMapping.path)) {
        expect(`${t.name}:${documented.has(f)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('maps variables through queryParams, never bodyMapping', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.bodyMapping === undefined}`).toBe(`${t.name}:true`);
    expect(a.tools.find((t) => t.name === 'slab_get_post')!.endpointMapping.queryParams).toEqual({ id: '$id' });
  });
});
