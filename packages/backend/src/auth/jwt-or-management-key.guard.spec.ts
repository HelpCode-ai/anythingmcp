import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { JwtOrManagementKeyGuard } from './jwt-or-management-key.guard';
import { apiKeySuffix, hashApiKey } from '../common/crypto/api-key-hash.util';

process.env.ENCRYPTION_KEY ??= 'unit-test-encryption-key-0123456789abcdef';

/**
 * Integration test for the management-key path of the guard, against a real
 * database. The JWT fallback (no key presented) is Passport's unchanged
 * behaviour and is not exercised here.
 */
const prisma = new PrismaService();
// Redis not connected → the per-key rate limit falls open (not under test here).
const noRedis = { isConnected: false } as never;
const guard = new JwtOrManagementKeyGuard(prisma as never, noRedis);

const TAG = `mgmtcli-test-${Date.now()}`;
const orgId = `${TAG}-org`;
const adminId = `${TAG}-admin`;
const memberId = `${TAG}-member`;

const keys = {
  mcp: `mcp_${'a'.repeat(40)}${Date.now()}`,
  read: `mcp_${'b'.repeat(40)}${Date.now()}`,
  admin: `mcp_${'c'.repeat(40)}${Date.now()}`,
  memberAdminScope: `mcp_${'d'.repeat(40)}${Date.now()}`,
  inactive: `mcp_${'e'.repeat(40)}${Date.now()}`,
  hashedOnly: `mcp_${'f'.repeat(40)}${Date.now()}`,
  expired: `mcp_${'1'.repeat(40)}${Date.now()}`,
  support: `mcp_${'2'.repeat(40)}${Date.now()}`,
};

function contextFor(key: string | undefined, method: string): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    method,
    headers: key ? { authorization: `Bearer ${key}` } : {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

beforeAll(async () => {
  await prisma.$connect();
  await prisma.organization.create({ data: { id: orgId, name: TAG } });
  await prisma.user.create({
    data: { id: adminId, email: `${TAG}-admin@test.local`, role: 'ADMIN', organizationId: orgId },
  });
  await prisma.user.create({
    data: { id: memberId, email: `${TAG}-member@test.local`, role: 'VIEWER', organizationId: orgId },
  });
  await prisma.organizationMember.create({ data: { userId: adminId, organizationId: orgId, role: 'ADMIN' } });
  await prisma.organizationMember.create({ data: { userId: memberId, organizationId: orgId, role: 'VIEWER' } });

  const mk = (key: string, userId: string, scope: 'MCP' | 'MANAGEMENT_READ' | 'MANAGEMENT_ADMIN', isActive = true) =>
    prisma.mcpApiKey.create({ data: { key, name: key.slice(0, 12), userId, organizationId: orgId, scope, isActive } });
  await mk(keys.mcp, adminId, 'MCP');
  await mk(keys.read, adminId, 'MANAGEMENT_READ');
  await mk(keys.admin, adminId, 'MANAGEMENT_ADMIN');
  await mk(keys.memberAdminScope, memberId, 'MANAGEMENT_ADMIN');
  await mk(keys.inactive, adminId, 'MANAGEMENT_ADMIN', false);
  // A row whose plaintext column no longer holds the key: only the hash can match.
  await prisma.mcpApiKey.create({
    data: {
      key: `${TAG}-not-a-key`,
      keyHash: hashApiKey(keys.hashedOnly),
      keySuffix: apiKeySuffix(keys.hashedOnly),
      name: 'hashed-only',
      userId: adminId,
      organizationId: orgId,
      scope: 'MANAGEMENT_READ',
    },
  });
  const hashedRow = (key: string, extra: Record<string, unknown>) =>
    prisma.mcpApiKey.create({
      data: {
        key: `${TAG}-placeholder-${key.slice(4, 12)}`,
        keyHash: hashApiKey(key),
        keySuffix: apiKeySuffix(key),
        name: key.slice(0, 12),
        userId: adminId,
        organizationId: orgId,
        scope: 'MANAGEMENT_READ',
        ...extra,
      },
    });
  await hashedRow(keys.expired, { expiresAt: new Date(Date.now() - 60_000) });
  await hashedRow(keys.support, { expiresAt: new Date(Date.now() + 60 * 60_000), isSupport: true });
});

afterAll(async () => {
  await prisma.mcpApiKey.deleteMany({ where: { organizationId: orgId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe('JwtOrManagementKeyGuard (management-key path)', () => {
  it('rejects an MCP-scoped key on the management API', async () => {
    const { ctx } = contextFor(keys.mcp, 'GET');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an inactive key', async () => {
    const { ctx } = contextFor(keys.inactive, 'GET');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a MANAGEMENT_READ key on a GET and sets the user+role', async () => {
    const { ctx, req } = contextFor(keys.read, 'GET');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: adminId, role: 'ADMIN', organizationId: orgId });
    expect(req.mcpKeyScope).toBe('MANAGEMENT_READ');
  });

  it('forbids a MANAGEMENT_READ key on a non-safe method', async () => {
    const { ctx } = contextFor(keys.read, 'POST');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a MANAGEMENT_ADMIN key on a POST', async () => {
    const { ctx, req } = contextFor(keys.admin, 'POST');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: adminId, role: 'ADMIN' });
  });

  it('carries a non-admin owner role even with an admin-scope key (RolesGuard will cap it)', async () => {
    const { ctx, req } = contextFor(keys.memberAdminScope, 'POST');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((req.user as { role: string }).role).toBe('VIEWER');
  });

  it('accepts the key via the X-API-Key header too', async () => {
    const req: Record<string, unknown> = { method: 'GET', headers: { 'x-api-key': keys.read } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rate-limits a key once Redis is connected and the per-minute ceiling is exceeded', async () => {
    const counts = new Map<string, number>();
    const fakeRedis = {
      isConnected: true,
      incr: async (k: string) => { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n; },
      expire: async () => undefined,
      ttl: async () => 60,
    } as never;
    const previous = process.env.MANAGEMENT_RATE_LIMIT_PER_MINUTE;
    process.env.MANAGEMENT_RATE_LIMIT_PER_MINUTE = '2';
    try {
      const limited = new JwtOrManagementKeyGuard(prisma as never, fakeRedis);
      const call = () => limited.canActivate(contextFor(keys.admin, 'GET').ctx);
      await expect(call()).resolves.toBe(true);
      await expect(call()).resolves.toBe(true);
      let thrown: unknown;
      try { await call(); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(429);
    } finally {
      if (previous === undefined) delete process.env.MANAGEMENT_RATE_LIMIT_PER_MINUTE;
      else process.env.MANAGEMENT_RATE_LIMIT_PER_MINUTE = previous;
    }
  });
});

describe('JwtOrManagementKeyGuard (keys hashed at rest)', () => {
  it('authenticates a key matched by its hash alone', async () => {
    const { ctx, req } = contextFor(keys.hashedOnly, 'GET');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: adminId, organizationId: orgId });
  });

  it('does not accept the stored hash as a key', async () => {
    const { ctx } = contextFor(`mcp_${hashApiKey(keys.hashedOnly)}`, 'GET');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('hashes a plaintext-only row the first time it is used', async () => {
    const { ctx } = contextFor(keys.admin, 'GET');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // The stamp is fire-and-forget; poll briefly for it.
    let row: { keyHash: string | null; keySuffix: string | null } | null = null;
    for (let i = 0; i < 20; i++) {
      row = await prisma.mcpApiKey.findUnique({
        where: { key: keys.admin },
        select: { keyHash: true, keySuffix: true },
      });
      if (row?.keyHash) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row).toEqual({ keyHash: hashApiKey(keys.admin), keySuffix: apiKeySuffix(keys.admin) });
  });
});

describe('JwtOrManagementKeyGuard (expiry and support keys)', () => {
  it('rejects an expired key', async () => {
    const { ctx } = contextFor(keys.expired, 'GET');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a live support key as its user, still read-only', async () => {
    const { ctx, req } = contextFor(keys.support, 'GET');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: adminId, organizationId: orgId });
    await expect(guard.canActivate(contextFor(keys.support, 'POST').ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
