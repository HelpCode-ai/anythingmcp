import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { SavedScriptsService } from './saved-scripts.service';
import { ScriptCaller } from './codebound.service';

// Opt in against the local development DB after applying migrations. These
// tests create their own tenant fixtures and remove only those fixtures.
const databaseTests =
  process.env.RUN_CODEBOUND_DB === '1' ? describe : describe.skip;
databaseTests('Saved scripts in PostgreSQL', () => {
  let db: PrismaClient;
  let service: SavedScriptsService;
  let a: ScriptCaller;
  let b: ScriptCaller;
  let serverA: string;
  let serverB: string;
  const organizations: string[] = [];
  const users: string[] = [];
  const runner = { run: jest.fn().mockResolvedValue({ result: { ok: true } }) };
  const license = {
    checkLicenseActive: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const client = () =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  const createService = (prisma: PrismaClient) =>
    new SavedScriptsService(
      prisma as any,
      runner as any,
      license as any,
      audit as any,
    );
  const body = () => ({
    name: 'Persistent summary',
    description: 'Database test fixture',
    mcpServerId: serverA,
    code: 'return { answer: input.value };',
    input: { value: 42 },
    allowedTools: [],
  });

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '5433'
    ) {
      throw new Error(
        'RUN_CODEBOUND_DB requires local development PostgreSQL on port 5433.',
      );
    }
    db = client();
    await db.$connect();
    const seed = async () => {
      const org = await db.organization.create({
        data: { name: `Codebound test ${randomUUID()}` },
      });
      organizations.push(org.id);
      const user = await db.user.create({
        data: {
          email: `codebound-${randomUUID()}@example.invalid`,
          role: 'ADMIN',
          organizationId: org.id,
        },
      });
      users.push(user.id);
      const server = await db.mcpServerConfig.create({
        data: { userId: user.id, organizationId: org.id, name: 'Test server' },
      });
      return {
        caller: {
          sub: user.id,
          email: user.email,
          organizationId: org.id,
          role: 'ADMIN',
        },
        server: server.id,
      };
    };
    const first = await seed();
    const second = await seed();
    a = first.caller;
    serverA = first.server;
    b = second.caller;
    serverB = second.server;
    service = createService(db);
  });

  afterEach(async () => {
    if (db && organizations.length)
      await db.codeboundScript.deleteMany({
        where: { organizationId: { in: organizations } },
      });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.user.deleteMany({
        where: { id: { in: users }, organizationId: { in: organizations } },
      });
      await db.organization.deleteMany({
        where: { id: { in: organizations } },
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('persists code, parameters and capabilities across database connections', async () => {
    const saved = await service.create(a, body());
    const secondConnection = client();
    try {
      const reopened = await createService(secondConnection).get(a, saved.id);
      expect(reopened).toEqual(
        expect.objectContaining({ ...body(), revision: 1 }),
      );
      expect((await service.list(a, {})).total).toBe(1);
    } finally {
      await secondConnection.$disconnect();
    }
  });

  it('denies cross-tenant list/open/edit/delete/run even with a known ID', async () => {
    const saved = await service.create(a, body());
    expect(await service.list(b, {})).toEqual({ items: [], total: 0 });
    await expect(service.get(b, saved.id)).rejects.toThrow('Script not found');
    await expect(
      service.update(b, saved.id, {
        ...body(),
        mcpServerId: serverB,
        revision: 1,
      }),
    ).rejects.toThrow('Script not found');
    await expect(service.delete(b, saved.id)).rejects.toThrow(
      'Script not found',
    );
    await expect(
      service.run(b, saved.id, { input: {}, revision: 1 }),
    ).rejects.toThrow('Script not found');
    expect((await service.get(a, saved.id)).revision).toBe(1);
  });

  it('accepts one of two concurrent writes and rejects the stale writer', async () => {
    const saved = await service.create(a, body());
    const results = await Promise.allSettled([
      service.update(a, saved.id, {
        ...body(),
        code: 'return 1;',
        revision: 1,
      }),
      service.update(a, saved.id, {
        ...body(),
        code: 'return 2;',
        revision: 1,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason.getStatus()).toBe(409);
    const current = await service.get(a, saved.id);
    expect(current.revision).toBe(2);
    await expect(
      service.run(a, saved.id, { input: {}, revision: 1 }),
    ).rejects.toThrow('Reopen it before running');
  });

  it('enforces the tenant/server boundary in the database as well as the API', async () => {
    await expect(
      service.create(a, { ...body(), mcpServerId: serverB }),
    ).rejects.toThrow('Active MCP server not found');
    await expect(
      db.codeboundScript.create({
        data: {
          ...body(),
          organizationId: a.organizationId,
          mcpServerId: serverB,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('deletes scripts permanently and cascades when their server is removed', async () => {
    const saved = await service.create(a, body());
    await service.delete(a, saved.id);
    await expect(service.get(a, saved.id)).rejects.toThrow('Script not found');
    await expect(
      service.run(a, saved.id, { input: {}, revision: 1 }),
    ).rejects.toThrow('Script not found');
    const temporary = await db.mcpServerConfig.create({
      data: {
        userId: a.sub,
        organizationId: a.organizationId,
        name: 'Temporary test server',
        slug: randomUUID(),
      },
    });
    const linked = await service.create(a, {
      ...body(),
      mcpServerId: temporary.id,
    });
    await db.mcpServerConfig.deleteMany({
      where: { id: temporary.id, organizationId: a.organizationId },
    });
    await expect(service.get(a, linked.id)).rejects.toThrow('Script not found');
  });
});
