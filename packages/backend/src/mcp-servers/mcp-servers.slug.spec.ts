import { ConflictException } from '@nestjs/common';
import { McpServersService } from './mcp-servers.service';

// The error production saw (ANYTHINGMCP-CLOUD-BACKEND-4).
function uniqueSlugViolation() {
  return Object.assign(
    new Error(
      'Invalid `prisma.mcpServerConfig.create()` invocation:\n\nUnique constraint failed on the constraint: `mcp_server_configs_organization_id_slug_key`',
    ),
    { code: 'P2002', meta: { modelName: 'McpServerConfig' } },
  );
}

function serviceWith(existingSlugs: string[], writeError?: unknown) {
  const write = writeError
    ? jest.fn().mockRejectedValue(writeError)
    : jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 's1', ...data }));
  const prisma = {
    mcpServerConfig: {
      findMany: jest.fn().mockResolvedValue(existingSlugs.map((slug) => ({ slug }))),
      create: write,
      update: write,
    },
  };
  return { service: new McpServersService(prisma as any, {} as any, {} as any), prisma };
}

describe('MCP server slugs', () => {
  it('derives a free slug from the name when it is taken', async () => {
    const { service } = serviceWith(['sales', 'sales-2', 'sales-team']);
    const created = await service.create('u1', 'org1', { name: 'Sales' });
    expect(created.slug).toBe('sales-3');
  });

  it('uses the derived slug as is when it is free', async () => {
    const { service } = serviceWith([]);
    expect((await service.create('u1', 'org1', { name: 'Sales Team' })).slug).toBe('sales-team');
  });

  it('answers 409 when an explicit slug is taken, instead of a 500', async () => {
    const { service, prisma } = serviceWith([], uniqueSlugViolation());
    const run = service.create('u1', 'org1', { name: 'Sales', slug: 'sales' });
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(run).rejects.toThrow(/slug "sales" already exists/);
    // An explicit slug is the user's: it is not renamed behind their back.
    expect(prisma.mcpServerConfig.findMany).not.toHaveBeenCalled();
  });

  it('answers 409 when renaming onto a taken slug', async () => {
    const { service } = serviceWith([], uniqueSlugViolation());
    await expect(service.update('s1', { slug: 'sales' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows every other error', async () => {
    const other = Object.assign(new Error('connection lost'), { code: 'P1001' });
    const { service } = serviceWith([], other);
    await expect(service.create('u1', 'org1', { name: 'X', slug: 'x' })).rejects.toBe(other);
  });
});

describe('McpServersService.createDefaultForUser — slug', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { McpServersService } = require('./mcp-servers.service');

  function build(existing: string[], name = 'Mario Rossi') {
    const create = jest.fn(async ({ data }: any) => ({ id: 'srv', ...data }));
    const prisma = {
      mcpServerConfig: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async ({ where }: any) =>
          existing.filter((s) => where.slug.in.includes(s)).map((slug) => ({ slug })),
        ),
        create,
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name, email: 'm@example.test' }) },
    };
    return { svc: new McpServersService(prisma as any, {} as any, {} as any), create };
  }

  it('takes `default` when it is free', async () => {
    const { svc, create } = build([]);
    await svc.createDefaultForUser('u1', 'org1');
    expect(create.mock.calls[0][0].data.slug).toBe('default');
  });

  it('gives a second member default-<name>', async () => {
    const { svc, create } = build(['default']);
    await svc.createDefaultForUser('u2', 'org1');
    expect(create.mock.calls[0][0].data.slug).toBe('default-mario-rossi');
  });

  it('numbers a member whose display name is already taken', async () => {
    // This used to hit the unique (org, slug) index and fail the sign-up.
    const { svc, create } = build(['default', 'default-mario-rossi', 'default-mario-rossi-2']);
    await svc.createDefaultForUser('u3', 'org1');
    expect(create.mock.calls[0][0].data.slug).toBe('default-mario-rossi-3');
  });
});
