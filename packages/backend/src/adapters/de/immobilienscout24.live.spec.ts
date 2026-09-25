import * as adapter from './immobilienscout24.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  instructions: string;
  probe?: { tool: string; params?: Record<string, unknown> };
  connector: { authType: string; authConfig: Record<string, string> };
  tools: Array<{
    name: string;
    endpointMapping: { path: string; queryParams?: Record<string, string> };
  }>;
};

const mapping = (name: string) =>
  a.tools.find((t) => t.name === name)!.endpointMapping;

describe('immobilienscout24 adapter — static spec conformance', () => {
  it('signs every request with OAuth 1.0a from the consumer key pair', () => {
    expect(a.connector.authType).toBe('OAUTH1');
    expect(a.connector.authConfig).toEqual({
      consumerKey: '{{IS24_CONSUMER_KEY}}',
      consumerSecret: '{{IS24_CONSUMER_SECRET}}',
    });
  });

  // The fields used to be IS24_CLIENT_ID / IS24_CLIENT_SECRET, which the
  // install form shows as "Client Id" — and both production installs typed
  // their login e-mail there, answered by IS24 with "Consumer not found:
  // <e-mail>". The names now say what ImmobilienScout24 itself calls them.
  it('names the fields after what ImmobilienScout24 issues', () => {
    expect(a.requiredEnvVars).toEqual(['IS24_CONSUMER_KEY', 'IS24_CONSUMER_SECRET']);
    expect(a.instructions).toMatch(/not the e-mail address/);
  });

  it('checks the key on the install form, where it can still be corrected', () => {
    expect(a.probe).toEqual({ tool: 'is24_search_locations', params: { query: 'Berlin' } });
  });

  it('uses the documented Geo Auto Completion resource', () => {
    const em = mapping('is24_search_locations');
    expect(em.path).toBe('/gis/v2.0/geoautocomplete/DEU');
    expect(em.queryParams?.i).toBe('$query');
  });

  // IS24 filters ranges as key=min-max; `price.min` and friends are not
  // search parameters and would have been ignored.
  it('sends ranges in the min-max form the Search API reads', () => {
    const qp = mapping('is24_search_properties').queryParams!;
    expect(qp.price).toBe('$price');
    expect(qp.livingspace).toBe('$livingspace');
    expect(qp.numberofrooms).toBe('$numberofrooms');
    expect(Object.keys(qp).some((k) => k.includes('.'))).toBe(false);
  });
});
