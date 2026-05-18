import {
  buildGraphqlBuiltinTools,
  slugifyForPrefix,
} from './graphql-builtins';

describe('slugifyForPrefix', () => {
  it.each([
    ['Sorare', 'sorare'],
    ['My GraphQL Service', 'my_graphql_service'],
    ['foo-bar.baz / qux', 'foo_bar_baz_qux'],
    ['  spaces  around  ', 'spaces_around'],
    ['CamelCase', 'camelcase'],
    ['', 'graphql'],
    ['!!!', 'graphql'],
  ])('slugifies %j → %j', (input, expected) => {
    expect(slugifyForPrefix(input)).toBe(expected);
  });
});

describe('buildGraphqlBuiltinTools', () => {
  const baseOpts = {
    prefix: 'demo',
    displayName: 'Demo API',
    baseUrl: 'https://api.example.com/graphql',
  };

  it('returns the five builtin tools in a stable order', () => {
    const tools = buildGraphqlBuiltinTools(baseOpts);
    expect(tools.map((t) => t.name)).toEqual([
      'demo_graphql_schema_url',
      'demo_graphql_schema',
      'demo_graphql_query',
      'demo_graphql_mutation',
      'demo_graphql_subscription',
    ]);
  });

  it('defaults schemaUrl to `${baseUrl}/schema` and strips trailing slashes', () => {
    const tools = buildGraphqlBuiltinTools({
      ...baseOpts,
      baseUrl: 'https://api.example.com/graphql/',
    });
    const url = tools.find((t) => t.name === 'demo_graphql_schema_url')!;
    expect((url.endpointMapping as { path: string }).path).toBe(
      'https://api.example.com/graphql/schema',
    );
  });

  it('honours an explicit schemaUrl override', () => {
    const tools = buildGraphqlBuiltinTools({
      ...baseOpts,
      schemaUrl: 'https://cdn.example.com/sdl.graphql',
    });
    for (const name of ['demo_graphql_schema_url', 'demo_graphql_schema']) {
      const tool = tools.find((t) => t.name === name)!;
      expect((tool.endpointMapping as { path: string }).path).toBe(
        'https://cdn.example.com/sdl.graphql',
      );
    }
  });

  it('schema_url tool uses method=static (no HTTP call)', () => {
    const tool = buildGraphqlBuiltinTools(baseOpts).find(
      (t) => t.name === 'demo_graphql_schema_url',
    )!;
    expect((tool.endpointMapping as { method: string }).method).toBe('static');
  });

  it('schema tool uses method=schema and accepts type/search/full params', () => {
    const tool = buildGraphqlBuiltinTools(baseOpts).find(
      (t) => t.name === 'demo_graphql_schema',
    )!;
    expect((tool.endpointMapping as { method: string }).method).toBe('schema');
    const params = tool.parameters as {
      properties: Record<string, { type: string }>;
    };
    expect(params.properties.type.type).toBe('string');
    expect(params.properties.search.type).toBe('string');
    expect(params.properties.full.type).toBe('boolean');
  });

  it.each(['query', 'mutation', 'subscription'])(
    '%s tool takes the operation as a param and forwards variables',
    (op) => {
      const tool = buildGraphqlBuiltinTools(baseOpts).find(
        (t) => t.name === `demo_graphql_${op}`,
      )!;
      const em = tool.endpointMapping as {
        method: string;
        path: string;
        variablesFromParam: string;
      };
      expect(em.method).toBe(op);
      expect(em.path).toBe(`$${op}`);
      expect(em.variablesFromParam).toBe('variables');
      const params = tool.parameters as { required: string[] };
      expect(params.required).toContain(op);
    },
  );
});
