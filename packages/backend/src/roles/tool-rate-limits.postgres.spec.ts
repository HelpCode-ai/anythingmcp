import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma.service';
import { RolesService } from './roles.service';

const url = process.env.AUDIT_TEST_DATABASE_URL;
(url ? describe : describe.skip)('tool rate limits — migrated PostgreSQL constraints', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    // Copy the real migrated CHECK constraints, without touching real grants
    // or copying foreign keys. This table lives only on this test connection.
    await client.query('CREATE TEMP TABLE rate_limit_probe (LIKE tool_role_access INCLUDING CONSTRAINTS)');
  });
  afterAll(async () => { await client?.end(); });

  it.each([[null, null], [1, 2147483647], [null, 20], [30, null]])('accepts positive or unlimited windows (%p, %p)', async (minute, hour) => {
    await expect(client.query(
      'INSERT INTO rate_limit_probe (id, role_id, tool_id, calls_per_minute, calls_per_hour) VALUES ($1, $2, $3, $4, $5)',
      ['probe', 'role', 'tool', minute, hour],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each([[0, null], [-1, 10], [null, 0], [10, -1]])('rejects invalid windows at the database boundary (%p, %p)', async (minute, hour) => {
    await expect(client.query(
      'INSERT INTO rate_limit_probe (id, role_id, tool_id, calls_per_minute, calls_per_hour) VALUES ($1, $2, $3, $4, $5)',
      ['probe', 'role', 'tool', minute, hour],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

(url ? describe : describe.skip)('role/tool rate limits — real tenant-scoped grants', () => {
  let prisma: PrismaClient;
  let roles: RolesService;
  let userId: string;
  let orgIds: string[];
  let roleIds: string[];
  let toolIds: string[];

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await prisma.$connect();
    roles = new RolesService(prisma as unknown as PrismaService);
  });
  beforeEach(async () => {
    orgIds = []; roleIds = []; toolIds = [];
    const user = await prisma.user.create({ data: { email: `rate-limit-${randomUUID()}@example.invalid` } });
    userId = user.id;
    for (let i = 0; i < 2; i++) {
      const org = await prisma.organization.create({ data: { name: 'rate limit test' } });
      orgIds.push(org.id);
      await prisma.organizationMember.create({ data: { userId, organizationId: org.id, role: 'EDITOR' } });
      const connector = await prisma.connector.create({
        data: { userId, organizationId: org.id, name: 'fixture', type: 'REST', baseUrl: 'https://example.invalid' },
      });
      const tool = await prisma.mcpTool.create({
        data: { connectorId: connector.id, name: 'query', description: 'fixture', parameters: {}, endpointMapping: {} },
      });
      toolIds.push(tool.id);
      const role = await prisma.role.create({ data: { name: 'limited', organizationId: org.id } });
      roleIds.push(role.id);
      await prisma.userRoleAssignment.create({ data: { userId, roleId: role.id, organizationId: org.id } });
      await prisma.toolRoleAccess.create({ data: {
        roleId: role.id, toolId: tool.id, callsPerMinute: i ? 9999 : 100, callsPerHour: i ? 99999 : 200,
      } });
    }
    const second = await prisma.role.create({ data: { name: 'second', organizationId: orgIds[0] } });
    roleIds.push(second.id);
    await prisma.userRoleAssignment.create({ data: { userId, roleId: second.id, organizationId: orgIds[0] } });
    await prisma.toolRoleAccess.create({ data: { roleId: second.id, toolId: toolIds[0], callsPerMinute: 10, callsPerHour: 10000 } });
  });
  afterEach(async () => {
    // Only the exact organizations and user created by this test are removed.
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('resolves the approved cross-window policy and excludes another workspace', async () => {
    expect(await roles.getToolRateLimits(userId, orgIds[0], toolIds[0]))
      .toEqual({ callsPerMinute: 100, callsPerHour: 10000 });
    expect(await roles.getToolRateLimits(userId, orgIds[0], toolIds[1])).toBeNull();
    await expect(roles.setToolRateLimits(roleIds[0], toolIds[0], orgIds[1], { callsPerMinute: null }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('keeps retained grant IDs and limits, removes revoked grants and adds unlimited ones', async () => {
    const connectorId = (await prisma.mcpTool.findUniqueOrThrow({ where: { id: toolIds[0] } })).connectorId;
    const added = await prisma.mcpTool.create({
      data: { connectorId, name: 'added', description: '', parameters: {}, endpointMapping: {} },
    });
    const removed = await prisma.mcpTool.create({
      data: { connectorId, name: 'removed', description: '', parameters: {}, endpointMapping: {} },
    });
    await prisma.toolRoleAccess.create({ data: { roleId: roleIds[0], toolId: removed.id } });
    const retained = await prisma.toolRoleAccess.findUniqueOrThrow({ where: { roleId_toolId: { roleId: roleIds[0], toolId: toolIds[0] } } });
    await roles.setToolAccess(roleIds[0], [toolIds[0], added.id], orgIds[0]);
    expect(await prisma.toolRoleAccess.findUnique({ where: { id: retained.id } })).toEqual(retained);
    expect(await prisma.toolRoleAccess.findUnique({ where: { roleId_toolId: { roleId: roleIds[0], toolId: removed.id } } })).toBeNull();
    expect(await prisma.toolRoleAccess.findUnique({ where: { roleId_toolId: { roleId: roleIds[0], toolId: added.id } } }))
      .toMatchObject({ callsPerMinute: null, callsPerHour: null });

    await expect(roles.setToolAccess(roleIds[0], [toolIds[1]], orgIds[0])).rejects.toMatchObject({ status: 400 });
    expect(await prisma.toolRoleAccess.findUnique({ where: { id: retained.id } })).toEqual(retained);
  });

  it('does not limit an ADMIN with assigned limited roles', async () => {
    await prisma.organizationMember.update({ where: { userId_organizationId: { userId, organizationId: orgIds[0] } }, data: { role: 'ADMIN' } });
    expect(await roles.getAllowedToolIds(userId, orgIds[0])).toBeNull();
    expect(await roles.getToolRateLimits(userId, orgIds[0], toolIds[0])).toBeNull();
  });
});
