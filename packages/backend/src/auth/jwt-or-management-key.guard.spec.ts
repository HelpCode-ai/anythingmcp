import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { JwtOrManagementKeyGuard } from './jwt-or-management-key.guard';

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
