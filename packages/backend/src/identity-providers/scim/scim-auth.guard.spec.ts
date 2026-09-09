import { createHash } from 'crypto';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimError } from './scim.errors';
import { SecurityEventService } from '../../audit/security-event.service';
import { PrismaService } from '../../common/prisma.service';

const TOKEN = 'scim_' + 'a'.repeat(43);
const HASH = createHash('sha256').update(TOKEN).digest('hex');

describe('ScimAuthGuard', () => {
  let prisma: any;
  let events: any[];
  let guard: ScimAuthGuard;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'idp-1',
    organizationId: 'org-1',
    type: 'ENTRA',
    isActive: true,
    scimEnabled: true,
    scimTokenHash: HASH,
    scimLastRequestAt: null,
    jitDefaultRole: 'VIEWER',
    roleSyncEnabled: true,
    roleSyncSource: 'GROUPS',
    roleSyncFallback: 'DENY_ALL',
    roleSyncDefaultRoleIds: [],
    ...over,
  });

  const ctxFor = (authorization?: string) => {
    const req: any = { headers: { authorization, 'user-agent': 'jest' }, ip: '127.0.0.1' };
    return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as any, req };
  };

  beforeEach(() => {
    events = [];
    prisma = {
      identityProvider: {
        findUnique: jest.fn(async () => row()),
        update: jest.fn(async () => ({})),
      },
      securityEvent: { create: jest.fn(async (a: any) => { events.push(a.data); return a.data; }) },
    };
    guard = new ScimAuthGuard(prisma, new SecurityEventService(prisma as unknown as PrismaService));
  });

  // Scanners hit unauthenticated endpoints constantly; none of them may cost a
  // database round trip or an audit row.
  it('refuses a missing or malformed header without touching the database', async () => {
    for (const h of [undefined, 'Basic abc', 'Bearer', 'Bearer short']) {
      await expect(guard.canActivate(ctxFor(h).ctx)).rejects.toBeInstanceOf(ScimError);
    }
    expect(prisma.identityProvider.findUnique).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('looks the token up by its sha256 digest', async () => {
    await guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx);
    expect(prisma.identityProvider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scimTokenHash: HASH } }),
    );
  });

  it('audits and refuses an unknown token', async () => {
    prisma.identityProvider.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx)).rejects.toBeInstanceOf(ScimError);
    expect(events).toEqual([expect.objectContaining({ event: 'SCIM_AUTH_FAILED', metadata: { providerId: null, reason: 'unknown_credential' } })]);
  });

  it.each([
    ['scim_disabled', { scimEnabled: false }],
    ['provider_inactive', { isActive: false }],
  ])('refuses with reason %s', async (reason, over) => {
    prisma.identityProvider.findUnique.mockResolvedValue(row(over));
    await expect(guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx)).rejects.toBeInstanceOf(ScimError);
    expect(events[0].metadata).toEqual({ providerId: 'idp-1', reason });
  });

  it('pins the provider on the request without the hash', async () => {
    const { ctx, req } = ctxFor(`Bearer ${TOKEN}`);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req.scimProvider).toMatchObject({ id: 'idp-1', organizationId: 'org-1', roleSyncSource: 'GROUPS' });
    expect(req.scimProvider.scimTokenHash).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('bumps last-seen at most once a minute, and never fails the request on it', async () => {
    await guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx);
    expect(prisma.identityProvider.update).toHaveBeenCalledTimes(1);

    prisma.identityProvider.findUnique.mockResolvedValue(row({ scimLastRequestAt: new Date(Date.now() - 10_000) }));
    await guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx);
    expect(prisma.identityProvider.update).toHaveBeenCalledTimes(1);

    prisma.identityProvider.findUnique.mockResolvedValue(row({ scimLastRequestAt: new Date(Date.now() - 120_000) }));
    prisma.identityProvider.update.mockRejectedValue(new Error('db down'));
    expect(await guard.canActivate(ctxFor(`Bearer ${TOKEN}`).ctx)).toBe(true);
  });
});
