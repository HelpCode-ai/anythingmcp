import { UserInfoController } from './userinfo.controller';

function res() {
  const r: any = {
    headers: {} as Record<string, string>,
    _status: 0,
    _body: undefined as unknown,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this._status = c; return this; },
    json(b: unknown) { this._body = b; return this; },
  };
  return r;
}

describe('UserInfoController', () => {
  const user = { id: 'cuid1', email: 'a@b.com', emailVerified: true, name: 'A' };
  const build = (verify: (t: string) => any, found: any = user) =>
    new UserInfoController(
      { verifyToken: jest.fn(verify) } as any,
      {
        user: { findUnique: jest.fn().mockResolvedValue(found) },
        oAuthUserProfile: { findUnique: jest.fn().mockResolvedValue({ externalId: 'cuid1' }) },
      } as any,
    );

  it('returns sub, email and email_verified for a valid access token', async () => {
    const r = res();
    await build(() => ({ sub: 'cuid1' })).get({ headers: { authorization: 'Bearer ok' } } as any, r);
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ sub: 'cuid1', email: 'a@b.com', email_verified: true, name: 'A' });
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  it('reports email_verified false when the account never verified', async () => {
    const r = res();
    await build(() => ({ sub: 'cuid1' }), { ...user, emailVerified: false }).get(
      { headers: { authorization: 'Bearer ok' } } as any,
      r,
    );
    expect((r._body as any).email_verified).toBe(false);
  });

  it('resolves a legacy e-mail sub through the OAuth profile, never by e-mail', async () => {
    const ctl = build(() => ({ sub: 'someone@else.com', user_profile_id: 'p1' }));
    const r = res();
    await ctl.get({ headers: { authorization: 'Bearer ok' } } as any, r);
    expect(r._status).toBe(200);
    expect((ctl as any).prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cuid1' } }),
    );
  });

  it('is 401 without a token, and says invalid_token only when one was presented', async () => {
    const r1 = res();
    await build(() => ({ sub: 'cuid1' })).get({ headers: {} } as any, r1);
    expect(r1._status).toBe(401);
    expect(r1.headers['WWW-Authenticate']).not.toContain('error=');

    const r2 = res();
    await build(() => { throw new Error('expired'); }).get({ headers: { authorization: 'Bearer stale' } } as any, r2);
    expect(r2._status).toBe(401);
    expect(r2.headers['WWW-Authenticate']).toContain('error="invalid_token"');
  });
});
