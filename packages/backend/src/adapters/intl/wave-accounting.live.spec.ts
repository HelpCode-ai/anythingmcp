import { parse, OperationDefinitionNode, FieldNode } from 'graphql';
import * as adapter from './wave-accounting.json';

const a = adapter as unknown as {
  probe?: { tool: string };
  connector: { baseUrl: string; type: string; authType: string };
  tools: Array<{
    name: string;
    parameters: { required?: string[] };
    endpointMapping: { path: string; queryParams?: Record<string, string>; bodyMapping?: unknown };
  }>;
};

const tool = (name: string) => a.tools.find((t) => t.name === name)!;

function rootFields(document: string): string[] {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  return op.selectionSet.selections.map((s) => (s as FieldNode).name.value);
}

describe('wave-accounting adapter — static spec conformance', () => {
  it('gql.waveapps.com/graphql/public base URL', () =>
    expect(a.connector.baseUrl).toBe('https://gql.waveapps.com/graphql/public'));
  it('GraphQL connector with Bearer auth', () => {
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });

  it('checks the token on install with a call that needs no arguments', () =>
    expect(a.probe?.tool).toBe('wave_get_businesses'));

  // Wave's public schema (introspection on gql.waveapps.com is open) has
  // businesses and business(id:) at the root; `user.businesses` and a root
  // `invoice(id:)` do not exist, and Wave answered GRAPHQL_VALIDATION_FAILED.
  it('only selects root fields from the published schema', () => {
    const documented = new Set(['businesses', 'business', 'customerCreate', 'invoiceSend']);
    for (const t of a.tools) {
      for (const f of rootFields(t.endpointMapping.path)) {
        expect(`${t.name}:${documented.has(f)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('reads an invoice through its business', () => {
    expect(tool('wave_get_invoice').parameters.required).toEqual(['business_id', 'invoice_id']);
    expect(tool('wave_get_invoice').endpointMapping.queryParams).toEqual({
      businessId: '$business_id',
      invoiceId: '$invoice_id',
    });
  });

  // The variables used to sit under bodyMapping, which the GraphQL engine
  // never reads: Wave answered every call with 'Variable "$bid" of required
  // type "ID!" was not provided.'
  it('maps variables through queryParams, never bodyMapping', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.bodyMapping === undefined}`).toBe(`${t.name}:true`);
    expect(tool('wave_create_customer').endpointMapping.queryParams).toEqual({
      businessId: '$business_id',
      name: '$name',
      email: '$email',
      currency: '$currency',
    });
  });
});
