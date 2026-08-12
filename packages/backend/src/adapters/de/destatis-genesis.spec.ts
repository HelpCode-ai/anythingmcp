import * as adapter from './destatis-genesis.json';

/**
 * Static conformance guards for the Destatis GENESIS adapter — always run, no
 * network and no credentials needed.
 *
 * These pin the migration off the GET/query-param auth that Destatis
 * permanently shut down on 30 June 2025 ("Die GET-Methoden mit Credentials
 * wurden durch die bisher parallel angebotenen POST-Methoden der
 * RESTful/JSON-Schnittstelle ersetzt" — Anwenderdokumentation 5.1,
 * 01.06.2026). Since that date a GET returns the GENESIS HTML web interface
 * instead of JSON, so a regression to GET or to QUERY_AUTH silently breaks
 * every tool in this adapter.
 *
 * Live reachability against the real API lives in destatis-genesis.live.spec.ts
 * (opt-in, needs an account).
 */

describe('destatis-genesis adapter — static spec conformance', () => {
  const a = adapter as unknown as {
    connector: {
      baseUrl: string;
      authType: string;
      authConfig: Record<string, unknown>;
    };
    requiredEnvVars: string[];
    optionalEnvVars?: string[];
    tools: Array<{
      name: string;
      endpointMapping: {
        method: string;
        path: string;
        bodyEncoding?: string;
        bodyMapping?: Record<string, unknown>;
        queryParams?: Record<string, unknown>;
      };
    }>;
  };

  it('targets the canonical GENESIS host (not the redirecting www- host)', () => {
    expect(a.connector.baseUrl).toBe(
      'https://genesis.destatis.de/genesisWS/rest/2020',
    );
    // www-genesis.destatis.de now answers with a 307 to the above.
    expect(a.connector.baseUrl).not.toContain('www-genesis');
  });

  it('sends credentials as HTTP headers, never as query params', () => {
    // Regression guard: QUERY_AUTH is exactly the shut-down mechanism.
    expect(a.connector.authType).not.toBe('QUERY_AUTH');
    expect(a.connector.authType).toBe('API_KEY');
    // Destatis expects header fields literally named `username` / `password`
    // — not Authorization: Basic.
    expect(a.connector.authConfig.headerName).toBe('username');
    expect(a.connector.authConfig.apiKey).toBe(
      '{{DESTATIS_USERNAME_OR_TOKEN}}',
    );
    expect(a.connector.authConfig.extraHeaders).toEqual({
      password: '{{DESTATIS_PASSWORD}}',
    });
  });

  it('requires only the username-or-token var; password is optional', () => {
    // The API token is placed in the `username` field and needs no password,
    // so gating the install on a password would block token-only setups.
    expect(a.requiredEnvVars).toEqual(['DESTATIS_USERNAME_OR_TOKEN']);
    expect(a.optionalEnvVars).toEqual(['DESTATIS_PASSWORD']);
  });

  it('uses POST with a form-urlencoded body for every tool', () => {
    for (const tool of a.tools) {
      expect(tool.endpointMapping.method).toBe('POST');
      expect(tool.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(tool.endpointMapping.bodyMapping).toBeDefined();
      // Parameters moved from the query string into the body — a leftover
      // queryParams block would put them back in the URL.
      expect(tool.endpointMapping.queryParams).toBeUndefined();
    }
  });

  it('never sends credentials inside a tool body or path', () => {
    const serialized = JSON.stringify(a.tools);
    expect(serialized).not.toContain('DESTATIS_USERNAME');
    expect(serialized).not.toContain('DESTATIS_PASSWORD');
  });

  it('maps the documented RESTful/JSON endpoints', () => {
    const byName = Object.fromEntries(
      a.tools.map((t) => [t.name, t.endpointMapping]),
    );
    expect(byName['destatis_login_check']).toMatchObject({
      method: 'POST',
      path: '/helloworld/logincheck',
    });
    expect(byName['destatis_search_tables']).toMatchObject({
      method: 'POST',
      path: '/find/find',
    });
    expect(byName['destatis_get_table']).toMatchObject({
      method: 'POST',
      path: '/data/table',
    });
    expect(byName['destatis_get_table_metadata']).toMatchObject({
      method: 'POST',
      path: '/metadata/table',
    });
    expect(byName['destatis_list_statistics']).toMatchObject({
      method: 'POST',
      path: '/catalogue/statistics',
    });
  });

  it('prefixes every tool name with destatis_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('destatis_')).toBe(true);
    }
  });
});
