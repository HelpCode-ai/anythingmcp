import * as adapter from './tidio.json';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe?: { tool: string };
  connector: {
    baseUrl: string;
    type: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string; extraHeaders: Record<string, string> };
    headers: Record<string, string>;
  };
  tools: Array<{
    name: string;
    endpointMapping: { method: string; path: string; headers?: Record<string, string> };
  }>;
};

describe('tidio adapter — static spec conformance', () => {
  // The adapter used to describe a GraphQL API at api.tidio.co/v1/graphql
  // with an X-Tidio-Openapi-Token header. Tidio has no GraphQL API: the
  // OpenAPI (developers.tidio.com) is REST at api.tidio.com.
  it('REST connector on api.tidio.com', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.tidio.com');
  });

  it('sends the client id + secret pair Tidio issues', () => {
    expect(a.requiredEnvVars).toEqual(['TIDIO_CLIENT_ID', 'TIDIO_CLIENT_SECRET']);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Tidio-Openapi-Client-Secret');
    expect(a.connector.authConfig.apiKey).toBe('{{TIDIO_CLIENT_SECRET}}');
    expect(a.connector.authConfig.extraHeaders).toEqual({
      'X-Tidio-Openapi-Client-Id': '{{TIDIO_CLIENT_ID}}',
    });
  });

  it('sends the mandatory API version header', () =>
    expect(a.connector.headers.Accept).toBe('application/json; version=1'));

  it('checks the keys on install', () => expect(a.probe?.tool).toBe('tidio_get_project'));

  it('only calls documented endpoints', () => {
    const documented = new Set([
      'GET /project',
      'GET /contacts',
      'GET /contacts/{contact_id}',
      'PATCH /contacts/{contact_id}',
      'GET /contacts/{contact_id}/messages',
      'GET /tickets',
      'GET /tickets/{ticket_id}',
      'POST /tickets/{ticket_id}/reply',
      'GET /operators',
    ]);
    for (const t of a.tools) {
      const call = `${t.endpointMapping.method} ${t.endpointMapping.path}`;
      expect(`${t.name}:${documented.has(call)}`).toBe(`${t.name}:true`);
    }
  });

  it('writes with the versioned JSON content type', () => {
    for (const t of a.tools.filter((t) => t.endpointMapping.method !== 'GET')) {
      expect(t.endpointMapping.headers?.['Content-Type']).toBe('application/json; version=1');
    }
  });
});
