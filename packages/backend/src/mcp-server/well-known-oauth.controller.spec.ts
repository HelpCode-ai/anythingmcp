import { WellKnownOAuthController } from './well-known-oauth.controller';

function res() {
  const r: any = {
    _status: 0,
    _type: '',
    _body: '',
    status(c: number) { this._status = c; return this; },
    type(t: string) { this._type = t; return this; },
    send(b: string) { this._body = b; return this; },
  };
  return r;
}

describe('WellKnownOAuthController — openai-apps-challenge', () => {
  const build = (token?: string) =>
    new WellKnownOAuthController({
      get: (k: string) => (k === 'OPENAI_APPS_CHALLENGE_TOKEN' ? token : undefined),
    } as any);

  it('serves the configured token as plain text', () => {
    const r = res();
    build('abc123').openaiAppsChallenge(r);
    expect(r._status).toBe(200);
    expect(r._type).toBe('text/plain');
    expect(r._body).toBe('abc123');
  });

  it('is a plain 404 when no token is configured', () => {
    const r = res();
    build(undefined).openaiAppsChallenge(r);
    expect(r._status).toBe(404);
    expect(r._body).not.toContain('undefined');
  });
});

describe('WellKnownOAuthController — authorization server metadata', () => {
  const controller = new WellKnownOAuthController({ get: () => undefined } as any);
  const req = { headers: { host: 'mcp.example.com' }, secure: true } as any;

  it('does not advertise the client_credentials grant, which /token refuses', () => {
    // Every client comes from open dynamic client registration, so
    // ClientCredentialsMiddleware refuses the grant for all of them.
    for (const meta of [
      controller.openidConfiguration(req),
      controller.openidConfigurationScoped(req),
      controller.authorizationServerScoped(req),
    ] as any[]) {
      expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    }
  });
});
