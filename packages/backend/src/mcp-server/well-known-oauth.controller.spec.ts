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
