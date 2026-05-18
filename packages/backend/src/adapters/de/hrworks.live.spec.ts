import * as adapter from './hrworks.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Smoke test against the real HR WORKS sandbox endpoint to verify that:
 *  - the adapter's baseUrl resolves
 *  - the RestEngine builds a request that HR WORKS accepts as syntactically valid
 *  - Bearer token injection actually puts the token in the Authorization header
 *    (we can tell because the API rejects a bogus token with 401 InvalidBearerTokenError
 *    instead of 403 MissingAuthorizationHeaderError)
 *
 * Skipped automatically in CI (no network); run locally with:
 *   RUN_HRWORKS_LIVE=1 npx jest src/adapters/de/hrworks.live.spec.ts
 */
const maybe = process.env.RUN_HRWORKS_LIVE ? describe : describe.skip;

maybe('hrworks adapter — live smoke test', () => {
  // Minimal stub — we don't exercise OAuth2 paths in this test
  const oauth = {} as unknown as OAuth2TokenService;
  const login = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, login);

  it('reaches HR WORKS auth endpoint and gets InvalidCredentials with bogus creds', async () => {
    const cfg = adapter as unknown as {
      connector: { baseUrl: string; authType: string };
    };

    let err: any;
    try {
      // POST /v2/authentication with bogus credentials — the adapter's auth
      // endpoint returns 403 InvalidCredentialsError for unknown keys.
      await engine.execute(
        { baseUrl: cfg.connector.baseUrl, authType: 'NONE' },
        {
          method: 'POST',
          path: '/v2/authentication',
          bodyMapping: { accessKey: '$accessKey', secretAccessKey: '$secretAccessKey' },
        },
        { accessKey: 'bogus-key-for-test', secretAccessKey: 'bogus-secret-for-test' },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.response?.status).toBe(403);
    expect(err.response?.data?.type).toBe('InvalidCredentialsError');
  }, 30000);

  it('Bearer token header is actually injected (bogus token → InvalidBearerTokenError, not MissingAuthorizationHeader)', async () => {
    const cfg = adapter as unknown as {
      connector: { baseUrl: string; authType: string };
      tools: Array<{ name: string; endpointMapping: any }>;
    };
    const orgUnits = cfg.tools.find((t) => t.name === 'hrworks_list_organization_units');
    expect(orgUnits).toBeDefined();

    let err: any;
    try {
      await engine.execute(
        {
          baseUrl: cfg.connector.baseUrl,
          authType: 'BEARER_TOKEN',
          authConfig: { token: 'eyJobviously.not.a.valid.jwt' },
        },
        orgUnits!.endpointMapping,
        {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // HR WORKS returns 403 InvalidBearerTokenError when the header was present but
    // the token is bogus; 403 MissingAuthorizationHeaderError would mean the engine
    // forgot to send the Authorization header at all.
    expect(err.response?.status).toBe(403);
    expect(err.response?.data?.type).toBe('InvalidBearerTokenError');
  }, 30000);
});
