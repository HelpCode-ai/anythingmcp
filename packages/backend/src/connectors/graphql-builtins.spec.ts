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

describe('slugifyForPrefix without a backtracking regex', () => {
  // The previous implementation, kept here as the reference the new one must
  // match. Its trim regex was polynomial on long runs of underscores.
  const reference = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'graphql';

  it('matches the previous output on awkward and random inputs', () => {
    const fixed = ['', '___', '--a--', 'A__B', ' x ', 'Ärger Öl', 'İstanbul API', '9lives', '..', 'a/b\\c'];
    const alphabet = 'aZ9_-. /\\ÄéİßŁ\t\n@';
    const random = Array.from({ length: 2000 }, (_, i) => {
      let str = '';
      let seed = i * 2654435761;
      const len = (i % 17) + 1;
      for (let j = 0; j < len; j++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        str += alphabet[seed % alphabet.length];
      }
      return str;
    });
    for (const input of [...fixed, ...random]) {
      expect(slugifyForPrefix(input)).toBe(reference(input));
    }
  });

  it('stays linear on the input that made the old regex crawl', () => {
    const hostile = '_'.repeat(50_000) + '!';
    const started = Date.now();
    expect(slugifyForPrefix(hostile)).toBe('graphql');
    expect(Date.now() - started).toBeLessThan(200);
  });
});

