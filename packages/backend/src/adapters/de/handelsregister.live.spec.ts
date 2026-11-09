import * as adapter from './handelsregister.json';

type Tool = { name: string; endpointMapping: { method: string; path: string; queryParams?: Record<string, string> } };
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('handelsregister adapter — static spec conformance', () => {
  it('handelsregister.ai/api/v1', () => expect(a.connector.baseUrl).toBe('https://handelsregister.ai/api/v1'));

  it('API key in the x-api-key header (Authorization: Bearer is for scoped tokens, not API keys)', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{HANDELSREGISTER_API_KEY}}' });
  });

  it('uses the documented endpoints (the old /search and /companies/{id} paths answer 404)', () => {
    expect(tool('handelsregister_search_companies').endpointMapping.path).toBe('/search-organizations');
    expect(tool('handelsregister_get_company').endpointMapping.path).toBe('/fetch-organization');
    expect(tool('handelsregister_get_shareholders').endpointMapping.path).toBe('/fetch-organization');
    expect(tool('handelsregister_fetch_document').endpointMapping.path).toBe('/fetch-document');
    expect(tool('handelsregister_fetch_person').endpointMapping.path).toBe('/fetch-person');
    expect(tool('handelsregister_list_signals').endpointMapping.path).toBe('/signals');
    expect(tool('handelsregister_get_signal').endpointMapping.path).toBe('/signals/{signal_id}');
    expect(tool('handelsregister_list_signal_topics').endpointMapping.path).toBe('/signals/catalog');
    expect(tool('handelsregister_get_account').endpointMapping.path).toBe('/account');
    expect(tool('handelsregister_get_credits').endpointMapping.path).toBe('/account/credits');
    expect(tool('handelsregister_get_usage').endpointMapping.path).toBe('/account/usage');
    expect(tool('handelsregister_get_subscription').endpointMapping.path).toBe('/account/subscription');
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
    }
  });

  it('signals send only the parameters the API accepts (any other answers 422)', () => {
    expect(Object.keys(tool('handelsregister_list_signals').endpointMapping.queryParams ?? {}).sort()).toEqual(
      ['cursor', 'from', 'organization_ids', 'to', 'topics'],
    );
    expect(tool('handelsregister_get_signal').endpointMapping.queryParams).toBeUndefined();
  });

  it('fetch-organization takes the entity_id as q', () => {
    expect(tool('handelsregister_get_company').endpointMapping.queryParams?.q).toBe('$company_id');
    expect(tool('handelsregister_get_shareholders').endpointMapping.queryParams).toEqual({ q: '$company_id', features: 'shareholders' });
  });
});

// Live check, read-only (1 credit per search): RUN_HANDELSREGISTER_LIVE=1 HANDELSREGISTER_API_KEY=... npx jest handelsregister
const live = process.env.RUN_HANDELSREGISTER_LIVE === '1' ? describe : describe.skip;
live('handelsregister adapter — live', () => {
  it('the key works in x-api-key (account endpoint, 0 credits)', async () => {
    const res = await fetch(`${a.connector.baseUrl}/account`, {
      headers: { 'x-api-key': process.env.HANDELSREGISTER_API_KEY ?? '' },
    });
    expect(res.status).toBe(200);
  });
});
