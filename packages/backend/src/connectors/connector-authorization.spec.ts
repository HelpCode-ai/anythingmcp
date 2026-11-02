import axios from 'axios';
import { encrypt } from '../common/crypto/encryption.util';
import { getAdapter } from '../adapters/catalog';
import { startConnectorAuthorization } from './connector-authorization';
import { McpOAuthService } from './mcp-oauth.service';

jest.mock('axios');
// assertSafeOutboundUrl performs DNS/SSRF checks — stub it out for unit tests.
jest.mock('../common/ssrf.util', () => ({
  ...jest.requireActual('../common/ssrf.util'),
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const KEY = 'a'.repeat(48);
const CALLBACK = 'https://cloud.anythingmcp.com/api/mcp-oauth/callback';

/**
 * The browser authorization of a REST connector: what is sent as
 * `redirect_uri`, on the authorization URL and on the code exchange.
 */
describe('startConnectorAuthorization redirect_uri', () => {
  let service: McpOAuthService;

  beforeEach(() => {
    service = new McpOAuthService();
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 7200 },
    } as any);
  });

  const deps = () => ({
    connectorsService: { updateAuthConfigMerge: jest.fn() },
    mcpOAuthService: service,
    logger: { log: jest.fn() },
    encryptionKey: KEY,
    callbackUrl: CALLBACK,
  });

  const row = (authConfig: Record<string, unknown>, envVars: Record<string, string>, adapterSlug?: string) => ({
    id: 'c1',
    type: 'REST' as const,
    baseUrl: 'https://api.example.com',
    authConfig: encrypt(JSON.stringify(authConfig), KEY),
    envVars,
    config: adapterSlug ? { adapterSlug } : {},
    headers: null,
  });

  /** Start the flow, then run the code exchange the callback would run. */
  const authorizeAndExchange = async (connector: ReturnType<typeof row>) => {
    const started = await startConnectorAuthorization(deps(), connector as any, { userId: 'u1' });
    if ('error' in started) throw new Error(started.error);
    const record = await service.getPendingFlow(started.state);
    const flow = record!.flow;
    await service.exchangeCodeForTokens({
      tokenUrl: flow.tokenUrl,
      code: 'the-code',
      redirectUri: flow.redirectUri,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      codeVerifier: flow.codeVerifier,
      tokenAuthMethod: flow.tokenAuthMethod,
    });
    const [, body] = mockedAxios.post.mock.calls[0];
    return { url: new URL(started.authorizationUrl), flow, body: new URLSearchParams(String(body)) };
  };

  it('sends the callback URL by default, on authorize and on the code exchange', async () => {
    const { url, flow, body } = await authorizeAndExchange(
      row(
        {
          clientId: 'cid',
          clientSecret: 'sec',
          authorizationUrl: 'https://provider.example/authorize',
          tokenUrl: 'https://provider.example/token',
        },
        {},
      ),
    );
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(flow.redirectUri).toBe(CALLBACK);
    expect(flow.callbackUrl).toBeUndefined();
    expect(body.get('redirect_uri')).toBe(CALLBACK);
  });

  it('sends providerRedirectUri instead, resolved from the env vars, on both requests', async () => {
    const { url, flow, body } = await authorizeAndExchange(
      row(
        {
          clientId: '{{APP_ID}}',
          clientSecret: '{{CERT_ID}}',
          authorizationUrl: 'https://auth.ebay.com/oauth2/authorize',
          tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
          tokenAuthMethod: 'basic',
          pkce: false,
          providerRedirectUri: '{{RUNAME}}',
        },
        { APP_ID: 'Jane-App-PRD-1', CERT_ID: 'PRD-secret', RUNAME: 'Jane_Doe-JaneDoe-MyApp-abcdef' },
      ),
    );
    expect(url.searchParams.get('redirect_uri')).toBe('Jane_Doe-JaneDoe-MyApp-abcdef');
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(flow.redirectUri).toBe('Jane_Doe-JaneDoe-MyApp-abcdef');
    // The provider-side setting must point at this server: kept for the error message.
    expect(flow.callbackUrl).toBe(CALLBACK);
    expect(body.get('redirect_uri')).toBe('Jane_Doe-JaneDoe-MyApp-abcdef');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBeNull();
    const [, , config] = mockedAxios.post.mock.calls[0];
    expect((config as any).headers.Authorization).toBe(
      `Basic ${Buffer.from('Jane-App-PRD-1:PRD-secret').toString('base64')}`,
    );
  });

  it('asks for the variable instead of starting a flow when the redirect name is not set', async () => {
    const started = await startConnectorAuthorization(
      deps(),
      row(
        {
          clientId: 'cid',
          clientSecret: 'sec',
          authorizationUrl: 'https://auth.ebay.com/oauth2/authorize',
          tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
          providerRedirectUri: '{{RUNAME}}',
        },
        { RUNAME: '' },
      ) as any,
      { userId: 'u1' },
    );
    expect(started).toEqual({ error: expect.stringContaining('RUNAME') });
  });

  it("takes the eBay adapter's settings for a connector installed before it had them", async () => {
    // As stored by an install from the old adapter: no authorization URL, no
    // redirect name, a refresh token pasted by hand.
    const { url, flow, body } = await authorizeAndExchange(
      row(
        {
          clientId: '{{EBAY_CLIENT_ID}}',
          clientSecret: '{{EBAY_CLIENT_SECRET}}',
          refreshToken: '{{EBAY_REFRESH_TOKEN}}',
          tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
          tokenAuthMethod: 'basic',
        },
        {
          EBAY_CLIENT_ID: 'Jane-App-PRD-1',
          EBAY_CLIENT_SECRET: 'PRD-secret',
          EBAY_REFRESH_TOKEN: 'v^1.1#old',
          EBAY_RUNAME: 'Jane_Doe-JaneDoe-MyApp-abcdef',
        },
        'ebay-sell',
      ),
    );
    const catalog = getAdapter('ebay-sell')!.connector.authConfig as Record<string, string>;
    expect(url.origin + url.pathname).toBe('https://auth.ebay.com/oauth2/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('Jane_Doe-JaneDoe-MyApp-abcdef');
    expect(url.searchParams.get('scope')).toBe(catalog.scopes);
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(body.get('redirect_uri')).toBe('Jane_Doe-JaneDoe-MyApp-abcdef');
    // Written next to the tokens once the sign-in succeeds, placeholder kept.
    expect(flow.persistAuthConfig).toMatchObject({
      authorizationUrl: 'https://auth.ebay.com/oauth2/authorize',
      providerRedirectUri: '{{EBAY_RUNAME}}',
    });
  });
});
