import * as adapter from './destatis-genesis.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Destatis GENESIS adapter — static conformance guards (always run) plus an
 * opt-in live reachability check.
 *
 * The static half pins the migration off the GET/query-param auth that Destatis
 * permanently shut down on 30 June 2025. Since that date a GET returns the
 * GENESIS HTML web interface instead of JSON, so a regression to GET or to
 * QUERY_AUTH silently breaks every tool here.
 *
 * The live half proves what static tests cannot: that the real API accepts
 * credentials as HTTP *header* fields and each endpoint accepts its parameters
 * as *body* fields. It drives the shipped `endpointMapping` blocks rather than
 * hand-written copies, so a mapping that drifts from what was verified fails
 * here instead of in a customer's connector.
 *
 * Run with a personal API token (password stays empty):
 *   RUN_DESTATIS_LIVE=1 DESTATIS_USERNAME_OR_TOKEN=<32-char-token> \
 *     npx jest src/adapters/de/destatis-genesis.live.spec.ts
 *
 * ...or with Nutzerkennung + password:
 *   RUN_DESTATIS_LIVE=1 DESTATIS_USERNAME_OR_TOKEN=<kennung> \
 *     DESTATIS_PASSWORD=<passwort> \
 *     npx jest src/adapters/de/destatis-genesis.live.spec.ts
 */

const a = adapter as unknown as {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  tools: Array<{
    name: string;
    parameters?: { properties?: Record<string, { description?: string }> };
    responseMapping?: { transform?: { mode?: string; expression?: string } };
    endpointMapping: {
      method: string;
      path: string;
      bodyEncoding?: string;
      bodyMapping?: Record<string, unknown>;
      queryParams?: Record<string, unknown>;
    };
  }>;
};

const byName = Object.fromEntries(a.tools.map((t) => [t.name, t]));

describe('destatis-genesis adapter — static spec conformance', () => {
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
    expect(byName['destatis_login_check'].endpointMapping).toMatchObject({
      method: 'POST',
      path: '/helloworld/logincheck',
    });
    expect(byName['destatis_search_tables'].endpointMapping).toMatchObject({
      method: 'POST',
      path: '/find/find',
    });
    expect(byName['destatis_get_table'].endpointMapping).toMatchObject({
      method: 'POST',
      path: '/data/table',
    });
    expect(
      byName['destatis_get_table_metadata'].endpointMapping,
    ).toMatchObject({ method: 'POST', path: '/metadata/table' });
    expect(byName['destatis_list_statistics'].endpointMapping).toMatchObject({
      method: 'POST',
      path: '/catalogue/statistics',
    });
  });

  it('declares the UTF-8 charset on the form body', () => {
    // Without it GENESIS decodes "Bev%C3%B6lkerung" as latin-1 and returns
    // Code 0 with no results — a silent wrong answer, not an error.
    expect(a.connector.headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded; charset=UTF-8',
    );
  });

  it('prefixes every tool name with destatis_', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('destatis_')).toBe(true);
    }
  });

  it('does not echo the credential back through destatis_login_check', () => {
    // The endpoint returns the caller's token verbatim in `Username`, which
    // would land in the model's context and in tool_invocations.output. The
    // transform reduces it to a boolean.
    const transform = byName['destatis_login_check'].responseMapping?.transform;
    expect(transform?.mode).toBe('jmespath');
    expect(transform?.expression).toContain('isGuest');
    expect(transform?.expression).not.toMatch(/Username\s*:/);
  });

  it('pins the catalogue sort criterion so the API returns Code 0', () => {
    // Without an explicit sortcriterion GENESIS answers Code 22 ("Mindestens
    // ein Parameter enthält ungültige Werte ... sortcriterion").
    expect(
      byName['destatis_list_statistics'].endpointMapping.bodyMapping,
    ).toMatchObject({ searchcriterion: 'Code', sortcriterion: 'Code' });
  });

  it('describes catalogue selection as a code pattern, not a keyword', () => {
    // `selection=Bevoelkerung` returns Code 104 with an empty list; only a
    // code prefix such as `122*` matches. A description promising keyword
    // search makes an agent read "no results" as "nothing exists".
    const desc =
      byName['destatis_list_statistics'].parameters?.properties?.selection
        ?.description ?? '';
    expect(desc).toMatch(/code/i);
    expect(desc).toMatch(/\*/);
  });
});

const live =
  process.env.RUN_DESTATIS_LIVE && process.env.DESTATIS_USERNAME_OR_TOKEN
    ? describe
    : describe.skip;

live('destatis-genesis adapter — live GENESIS API reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const config = {
    baseUrl: a.connector.baseUrl,
    // Ship-what-you-test: the charset in this header is what makes an umlaut
    // survive the round trip.
    headers: a.connector.headers,
    authType: 'API_KEY',
    authConfig: {
      headerName: 'username',
      apiKey: process.env.DESTATIS_USERNAME_OR_TOKEN as string,
      // Empty string when identifying via API token — matching Destatis'
      // own Python example (`'password': ""`).
      extraHeaders: { password: process.env.DESTATIS_PASSWORD || '' },
    },
  };

  /** Drive a tool exactly as the shipped adapter defines it. */
  const callTool = (name: string, params: Record<string, unknown>) =>
    engine.execute(config, byName[name].endpointMapping, params);

  it('logincheck reports a real account rather than the GAST guest', async () => {
    const res = (await callTool('destatis_login_check', {
      language: 'de',
    })) as { Status?: string; Username?: string };
    expect(res).toBeDefined();
    // The raw response carries the token in `Username`; the adapter's
    // responseMapping is applied downstream, so assert on the raw shape here.
    expect(res.Username).not.toBe('GAST');
    expect(res.Status).toContain('erfolgreich');
  }, 30000);

  it('find/find accepts term/category as body fields', async () => {
    const res = (await callTool('destatis_search_tables', {
      searchterm: 'Bevölkerung',
      language: 'de',
    })) as { Status?: { Code?: number }; Tables?: unknown[] };
    expect(res.Status?.Code).toBe(0);
    expect(Array.isArray(res.Tables)).toBe(true);
  }, 30000);

  it('data/table returns a table for a known code', async () => {
    const res = (await callTool('destatis_get_table', {
      name: '12411-0001',
      startyear: '2020',
      endyear: '2024',
      language: 'de',
    })) as { Status?: { Code?: number }; Object?: unknown };
    expect(res.Status?.Code).toBe(0);
    expect(res.Object).toBeDefined();
  }, 30000);

  it('metadata/table returns table metadata', async () => {
    const res = (await callTool('destatis_get_table_metadata', {
      name: '12411-0001',
      language: 'de',
    })) as { Status?: { Code?: number } };
    expect(res.Status?.Code).toBe(0);
  }, 30000);

  it('catalogue/statistics lists statistics with the selection omitted', async () => {
    // `selection` maps from an optional tool param — when the caller omits it
    // the key must drop out of the body rather than be sent as "$selection".
    const res = (await callTool('destatis_list_statistics', {
      language: 'de',
    })) as { Status?: { Code?: number }; List?: unknown[] };
    expect(res.Status?.Code).toBe(0);
    expect(Array.isArray(res.List)).toBe(true);
  }, 30000);

  it('catalogue/statistics filters by a code pattern', async () => {
    const res = (await callTool('destatis_list_statistics', {
      selection: '122*',
      language: 'de',
    })) as { Status?: { Code?: number }; List?: unknown[] };
    expect(res.Status?.Code).toBe(0);
    expect((res.List ?? []).length).toBeGreaterThan(0);
  }, 30000);
});
