import { UnsubscribeController } from './unsubscribe.controller';
import { buildUnsubscribeUrl, signUnsubscribe, verifyUnsubscribe } from './unsubscribe-token';

describe('one-click unsubscribe', () => {
  const ENV = { ...process.env };
  const SECRET = 'unit-test-secret';

  function res() {
    const r: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: '',
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      send(b: string) {
        this.body = b;
      },
    };
    return r;
  }

  let prisma: { user: { updateMany: jest.Mock } };
  let controller: UnsubscribeController;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    prisma = { user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    controller = new UnsubscribeController(prisma as any, { isCloud: () => true } as any);
  });

  afterAll(() => {
    process.env = ENV;
  });

  describe('tokens', () => {
    it('verifies its own signature for the same user only', () => {
      const t = signUnsubscribe('user-1', SECRET);
      expect(verifyUnsubscribe('user-1', t, SECRET)).toBe(true);
      expect(verifyUnsubscribe('user-2', t, SECRET)).toBe(false);
      expect(verifyUnsubscribe('user-1', t, 'other-secret')).toBe(false);
      expect(verifyUnsubscribe('user-1', t.slice(0, -1), SECRET)).toBe(false);
      expect(verifyUnsubscribe('user-1', undefined, SECRET)).toBe(false);
      expect(verifyUnsubscribe(['user-1'], t, SECRET)).toBe(false);
    });

    it('builds a URL on the dashboard origin', () => {
      const url = new URL(buildUnsubscribeUrl('https://cloud.anythingmcp.com/', 'user-1', SECRET));
      expect(url.origin + url.pathname).toBe('https://cloud.anythingmcp.com/api/public/unsubscribe');
      expect(url.searchParams.get('u')).toBe('user-1');
    });
  });

  it('GET only asks; it never unsubscribes (link scanners fetch every URL)', () => {
    const r = res();
    controller.confirm('user-1', signUnsubscribe('user-1', SECRET), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<form method="POST"');
    expect(r.body).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(r.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('POST (RFC 8058 one-click) opts the user out of marketing email', async () => {
    const r = res();
    await controller.unsubscribe('user-1', signUnsubscribe('user-1', SECRET), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('You are unsubscribed');
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { emailMarketingOptOut: true },
    });
  });

  it.each([
    ['a forged token', 'user-1', 'not-the-token'],
    ['another user’s token', 'user-2', signUnsubscribe('user-1', SECRET)],
    ['no token', 'user-1', undefined],
  ])('refuses %s', async (_label, u, t) => {
    const r = res();
    await controller.unsubscribe(u, t as any, r);
    expect(r.statusCode).toBe(400);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('refuses everything when no signing secret is configured', async () => {
    const t = signUnsubscribe('user-1', SECRET);
    delete process.env.JWT_SECRET;
    const r = res();
    await controller.unsubscribe('user-1', t, r);
    expect(r.statusCode).toBe(400);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('escapes the ids it puts back into the page', () => {
    const r = res();
    const id = '"><script>x</script>';
    controller.confirm(id, signUnsubscribe(id, SECRET), r);
    expect(r.body).not.toContain('<script>x');
  });
});
