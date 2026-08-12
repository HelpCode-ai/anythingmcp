import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Live reachability check for the Destatis GENESIS adapter. Skipped unless
 * RUN_DESTATIS_LIVE is set AND DESTATIS_USERNAME_OR_TOKEN is provided.
 *
 * This is the layer that proves what static tests cannot: that the real API
 * accepts credentials as HTTP *header* fields and that each endpoint accepts
 * its parameters as *body* fields (they used to be query params).
 *
 * Run with a personal API token (password stays empty):
 *   RUN_DESTATIS_LIVE=1 DESTATIS_USERNAME_OR_TOKEN=<32-char-token> \
 *     npx jest src/adapters/de/destatis-genesis.live.spec.ts
 *
 * ...or with Nutzerkennung + password:
 *   RUN_DESTATIS_LIVE=1 DESTATIS_USERNAME_OR_TOKEN=<kennung> \
 *     DESTATIS_PASSWORD=<passwort> \
 *     npx jest src/adapters/de/destatis-genesis.live.spec.ts
 *
 * NOTE: importing RestEngine currently drags in
 * connectors/engines/unblocker-proxy-agent.ts, which does not type-check
 * against the installed https-proxy-agent typings. That breakage is
 * pre-existing (oxomi.live.spec.ts fails the same way) and blocks this suite
 * from running until it is fixed. The static guards in
 * destatis-genesis.spec.ts are unaffected.
 */

const live =
  process.env.RUN_DESTATIS_LIVE && process.env.DESTATIS_USERNAME_OR_TOKEN
    ? describe
    : describe.skip;

live('destatis-genesis adapter — live GENESIS API reachability', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  const config = {
    baseUrl: 'https://genesis.destatis.de/genesisWS/rest/2020',
    authType: 'API_KEY',
    authConfig: {
      headerName: 'username',
      apiKey: process.env.DESTATIS_USERNAME_OR_TOKEN as string,
      // Empty string when identifying via API token — matching Destatis'
      // own Python example (`'password': ""`).
      extraHeaders: { password: process.env.DESTATIS_PASSWORD || '' },
    },
  };

  const call = (
    path: string,
    bodyMapping: Record<string, unknown>,
    params: Record<string, unknown>,
  ) =>
    engine.execute(
      config,
      { method: 'POST', path, bodyEncoding: 'form-urlencoded', bodyMapping },
      params,
    );

  it('logincheck authenticates and does NOT fall back to the GAST guest account', async () => {
    const res = (await call(
      '/helloworld/logincheck',
      { language: '$language' },
      { language: 'de' },
    )) as { Status?: string; Username?: string };
    expect(res).toBeDefined();
    // A missing/unresolved credential does not error — GENESIS silently logs
    // the caller in as GAST and returns guest-level data. Assert we are not it.
    expect(res.Username).not.toBe('GAST');
    expect(res.Status).toContain('erfolgreich');
  }, 30000);

  it('find/find accepts term/category as body fields', async () => {
    const res = (await call(
      '/find/find',
      { term: '$searchterm', category: 'tables', language: '$language' },
      { searchterm: 'Bevölkerung', language: 'de' },
    )) as { Status?: { Code?: number }; Tables?: unknown[] };
    expect(res.Status?.Code).toBe(0);
    expect(Array.isArray(res.Tables)).toBe(true);
  }, 30000);

  it('data/table returns a table for a known code', async () => {
    const res = (await call(
      '/data/table',
      {
        name: '$name',
        startyear: '$startyear',
        endyear: '$endyear',
        language: '$language',
      },
      {
        name: '12411-0001',
        startyear: '2020',
        endyear: '2024',
        language: 'de',
      },
    )) as { Status?: { Code?: number }; Object?: unknown };
    expect(res.Status?.Code).toBe(0);
    expect(res.Object).toBeDefined();
  }, 30000);

  it('metadata/table returns table metadata', async () => {
    const res = (await call(
      '/metadata/table',
      { name: '$name', language: '$language' },
      { name: '12411-0001', language: 'de' },
    )) as { Status?: { Code?: number } };
    expect(res.Status?.Code).toBe(0);
  }, 30000);

  it('catalogue/statistics lists statistics with the selection filter omitted', async () => {
    // `selection` maps from an optional tool param — when the caller omits it
    // the key must drop out of the body rather than be sent as "$searchterm".
    const res = (await call(
      '/catalogue/statistics',
      { selection: '$searchterm', language: '$language' },
      { language: 'de' },
    )) as { Status?: { Code?: number } };
    expect(res.Status?.Code).toBe(0);
  }, 30000);
});
