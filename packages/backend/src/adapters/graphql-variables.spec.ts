import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { Kind, OperationDefinitionNode, parse } from 'graphql';
import { getAdapter, listAdapters } from './catalog';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';

/**
 * Every typed GraphQL tool in the catalog, run through the real GraphqlEngine
 * against a local HTTP server, with the body it puts on the wire inspected.
 *
 * The engine builds `variables` from `endpointMapping.queryParams` (one flat
 * entry per variable, `"$param"` or a literal) or from `variablesFromParam`,
 * and from nothing else. Buffer, Slab, Tidio and Wave shipped their variables
 * under `bodyMapping.variables`, which the engine never reads: every call sent
 * `"variables":{}`, and a required ID reached the API as null. The validator
 * (scripts/validate-adapters.mjs, rule graphql-variables) rejects that shape
 * statically; this spec proves the same thing end to end.
 */

type Tool = {
  name: string;
  parameters: { properties?: Record<string, { type?: string }> };
  endpointMapping: Record<string, unknown>;
};

const cases: Array<[string, string, Tool]> = listAdapters()
  .map((meta) => getAdapter(meta.slug)!)
  .filter((adapter) => adapter.connector.type === 'GRAPHQL')
  .flatMap((adapter) =>
    (adapter.tools as unknown as Tool[])
      .filter((tool) => {
        const em = tool.endpointMapping;
        // The generic builtins take the operation and its variables as input.
        return (
          (em.method === 'query' || em.method === 'mutation') &&
          typeof em.path === 'string' &&
          !em.path.startsWith('$')
        );
      })
      .map((tool): [string, string, Tool] => [adapter.slug, tool.name, tool]),
  );

/** A distinct, recognisable value for each parameter, by its JSON Schema type. */
function sampleValue(name: string, type: string | undefined): unknown {
  switch (type) {
    case 'integer':
    case 'number':
      return 7;
    case 'boolean':
      return true;
    case 'array':
      return [`sample_${name}`];
    case 'object':
      return { sample: name };
    default:
      return `sample_${name}`;
  }
}

describe('GraphQL catalog tools put their parameters into `variables`', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastBody: { query?: string; variables?: Record<string, unknown> } = {};
  const engine = new GraphqlEngine({} as never, {} as never, {} as never);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        lastBody = JSON.parse(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end('{"data":{}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('covers the GraphQL adapters that ship typed tools', () => {
    const slugs = new Set(cases.map(([slug]) => slug));
    for (const slug of ['buffer', 'slab', 'sorare', 'wave-accounting']) {
      expect(slugs).toContain(slug);
    }
  });

  it.each(cases)('%s / %s', async (_slug, _name, tool) => {
    const em = tool.endpointMapping;
    const props = tool.parameters?.properties ?? {};
    const params = Object.fromEntries(
      Object.entries(props).map(([name, def]) => [name, sampleValue(name, def?.type)]),
    );

    await engine.execute(
      { baseUrl, authType: 'NONE' },
      em as unknown as Parameters<GraphqlEngine['execute']>[1],
      params,
    );
    const sent = lastBody.variables ?? {};

    const op = parse(String(em.path)).definitions.find(
      (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
    )!;
    const declared = op.variableDefinitions ?? [];

    // A non-null variable without a default must always be on the wire.
    for (const def of declared) {
      if (def.type.kind === Kind.NON_NULL_TYPE && !def.defaultValue) {
        expect({ variable: def.variable.name.value, value: sent[def.variable.name.value] })
          .toEqual({ variable: def.variable.name.value, value: expect.anything() });
      }
    }

    // Every variable sent is one the operation declares (extras are ignored
    // by GraphQL servers, i.e. silently lost).
    const declaredNames = new Set(declared.map((d) => d.variable.name.value));
    for (const key of Object.keys(sent)) expect(declaredNames).toContain(key);

    // Every tool parameter reaches the request, unchanged, as a variable or a
    // mapped header.
    const headerParams = Object.values((em.headers ?? {}) as Record<string, string>)
      .filter((v) => typeof v === 'string' && v.startsWith('$'))
      .map((v) => v.slice(1));
    const sentValues = Object.values(sent).map((v) => JSON.stringify(v));
    for (const [name, value] of Object.entries(params)) {
      if (headerParams.includes(name)) continue;
      expect({ param: name, sent: sentValues.includes(JSON.stringify(value)) })
        .toEqual({ param: name, sent: true });
    }
  });
});
