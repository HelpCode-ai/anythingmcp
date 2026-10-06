import * as adapter from './seamless-ai.json';

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown> };
};
const a = adapter as unknown as {
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('seamless-ai adapter: static spec conformance', () => {
  it('Public API v1 with the key in the Token header', () => {
    expect(a.connector.baseUrl).toBe('https://api.seamless.ai/api/client/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Token', apiKey: '{{SEAMLESS_AI_API_KEY}}' });
  });

  it('probe is the free /oauth/me', () => expect(tool(a.probe.tool).endpointMapping).toMatchObject({ method: 'GET', path: '/oauth/me' }));

  it('searches are POST but read-only; research is a write (spends credits, adds records to the org)', () => {
    expect(tool('seamless_ai_search_contacts').annotations?.readOnlyHint).toBe(true);
    expect(tool('seamless_ai_search_companies').annotations?.readOnlyHint).toBe(true);
    expect(tool('seamless_ai_research_contacts').annotations?.readOnlyHint).toBeUndefined();
    expect(tool('seamless_ai_research_companies').annotations?.readOnlyHint).toBeUndefined();
  });

  it('search bodies use the API field names', () => {
    expect(tool('seamless_ai_search_contacts').endpointMapping.bodyMapping).toMatchObject({ jobTitle: '$job_title', nextToken: '$next_token', __merge: '$extra_filters' });
    expect(tool('seamless_ai_research_contacts').endpointMapping.bodyMapping).toMatchObject({ searchResultIds: '$search_result_ids' });
  });
});
