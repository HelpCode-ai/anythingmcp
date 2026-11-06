import { hashApiKey } from '../common/crypto/api-key-hash.util';
import {
  isKeyExpired,
  listSupportKeys,
  mintSupportKey,
  parseOperator,
  parseScope,
  parseTtlMinutes,
  planSupportKey,
  revokeSupportKey,
} from './support-keys';
import { parseArgs, runSupportKeysCli } from './support-keys.cli';

process.env.ENCRYPTION_KEY ??= 'unit-test-encryption-key-0123456789abcdef';

function fakePrisma(overrides: Record<string, any> = {}) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'ana@acme.test' }) },
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue({ role: 'EDITOR', deactivatedAt: null }),
      findMany: jest.fn().mockResolvedValue([{ organizationId: 'org-1' }]),
    },
    organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Acme' }) },
    mcpServerConfig: { findFirst: jest.fn().mockResolvedValue({ id: 'srv-1', name: 'Sales' }) },
    mcpApiKey: {
      create: jest.fn().mockResolvedValue({ id: 'sk-1' }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as any;
}

const baseReq = { email: 'Ana@Acme.test ', scope: 'MCP' as const, ttlMinutes: 60, operator: 'matteo' };

describe('support keys', () => {
  describe('parsing', () => {
    it('parses the TTL in minutes or hours, defaulting to 60 minutes', () => {
      expect(parseTtlMinutes(undefined)).toBe(60);
      expect(parseTtlMinutes('45m')).toBe(45);
      expect(parseTtlMinutes('90')).toBe(90);
      expect(parseTtlMinutes('2h')).toBe(120);
      expect(parseTtlMinutes('24h')).toBe(1440);
    });

    it('refuses a TTL outside 1 minute .. 24 hours or not a duration', () => {
      expect(() => parseTtlMinutes('0')).toThrow(/between 1 minute and 24 hours/);
      expect(() => parseTtlMinutes('25h')).toThrow(/between 1 minute and 24 hours/);
      expect(() => parseTtlMinutes('1d')).toThrow(/Invalid --ttl/);
    });

    it('defaults the scope to MCP and refuses unknown scopes', () => {
      expect(parseScope(undefined)).toBe('MCP');
      expect(parseScope('management_read')).toBe('MANAGEMENT_READ');
      expect(() => parseScope('ROOT')).toThrow(/Invalid --scope/);
    });

    it('requires a plain operator label', () => {
      expect(parseOperator('matteo')).toBe('matteo');
      expect(() => parseOperator(undefined)).toThrow(/--operator is required/);
      expect(() => parseOperator('a b')).toThrow(/--operator is required/);
    });

    it('treats a past or present expiry as expired and null as never', () => {
      const now = new Date('2026-11-06T12:00:00Z');
      expect(isKeyExpired(null, now)).toBe(false);
      expect(isKeyExpired(new Date('2026-11-06T12:00:00Z'), now)).toBe(true);
      expect(isKeyExpired(new Date('2026-11-06T12:00:01Z'), now)).toBe(false);
    });
  });

  describe('planSupportKey', () => {
    it('resolves the only workspace of the user and the server by slug', async () => {
      const prisma = fakePrisma();
      const plan = await planSupportKey(prisma, { ...baseReq, server: 'sales' });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'ana@acme.test' }, select: { id: true, email: true } });
      expect(prisma.mcpServerConfig.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', OR: [{ id: 'sales' }, { slug: 'sales' }] },
        select: { id: true, name: true },
      });
      expect(plan).toMatchObject({
        userId: 'u1', organizationId: 'org-1', organizationName: 'Acme', role: 'EDITOR',
        mcpServerId: 'srv-1', mcpServerName: 'Sales', scope: 'MCP', ttlMinutes: 60,
      });
    });

    it('asks for --workspace when the user belongs to several', async () => {
      const prisma = fakePrisma();
      prisma.organizationMember.findMany.mockResolvedValue([{ organizationId: 'a' }, { organizationId: 'b' }]);
      await expect(planSupportKey(prisma, baseReq)).rejects.toThrow(/2 workspaces: pass --workspace <id> \(a, b\)/);
    });

    it('refuses an unknown user, a deactivated member and a server of another workspace', async () => {
      const noUser = fakePrisma();
      noUser.user.findUnique.mockResolvedValue(null);
      await expect(planSupportKey(noUser, baseReq)).rejects.toThrow(/No user/);

      const gone = fakePrisma();
      gone.organizationMember.findUnique.mockResolvedValue({ role: 'EDITOR', deactivatedAt: new Date() });
      await expect(planSupportKey(gone, { ...baseReq, workspaceId: 'org-1' })).rejects.toThrow(/not an active member/);

      const otherServer = fakePrisma();
      otherServer.mcpServerConfig.findFirst.mockResolvedValue(null);
      await expect(planSupportKey(otherServer, { ...baseReq, server: 'srv-x' })).rejects.toThrow(/No MCP server "srv-x"/);
    });
  });

  describe('mintSupportKey', () => {
    it('stores only the hash, an expiry and the support flag; the clear key is returned once', async () => {
      const prisma = fakePrisma();
      const plan = await planSupportKey(prisma, { ...baseReq, server: 'sales', ttlMinutes: 30 });
      const now = new Date('2026-11-06T12:00:00Z');
      const minted = await mintSupportKey(prisma, plan, now);

      expect(minted.key).toMatch(/^mcp_[0-9a-f]{64}$/);
      expect(minted.expiresAt.toISOString()).toBe('2026-11-06T12:30:00.000Z');
      expect(minted.name).toBe('support:matteo:2026-11-06T12:00Z');
      const data = prisma.mcpApiKey.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        userId: 'u1', organizationId: 'org-1', mcpServerId: 'srv-1', scope: 'MCP',
        isSupport: true, keyHash: hashApiKey(minted.key), keySuffix: minted.key.slice(-8),
      });
      expect(data.expiresAt).toEqual(minted.expiresAt);
      // The plaintext column never holds the key.
      expect(data.key).toMatch(/^support_[0-9a-f]{48}$/);
      expect(JSON.stringify(data)).not.toContain(minted.key);
    });
  });

  describe('revoke and list', () => {
    it('revokes a support key at once and refuses anything else', async () => {
      const prisma = fakePrisma();
      const now = new Date('2026-11-06T12:00:00Z');
      prisma.mcpApiKey.findFirst.mockResolvedValue({ id: 'sk-1', name: 'support:matteo:x', isActive: true, expiresAt: new Date('2026-11-06T13:00:00Z') });
      expect(await revokeSupportKey(prisma, 'sk-1', now)).toEqual({ id: 'sk-1', name: 'support:matteo:x', wasActive: true });
      expect(prisma.mcpApiKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sk-1', isSupport: true } }));
      expect(prisma.mcpApiKey.update).toHaveBeenCalledWith({ where: { id: 'sk-1' }, data: { isActive: false, expiresAt: now } });

      prisma.mcpApiKey.findFirst.mockResolvedValue(null);
      await expect(revokeSupportKey(prisma, 'user-key', now)).rejects.toThrow(/No support key user-key/);
    });

    it('keeps an earlier expiry when revoking an expired key', async () => {
      const prisma = fakePrisma();
      const past = new Date('2026-11-06T11:00:00Z');
      prisma.mcpApiKey.findFirst.mockResolvedValue({ id: 'sk-1', name: 'n', isActive: true, expiresAt: past });
      const r = await revokeSupportKey(prisma, 'sk-1', new Date('2026-11-06T12:00:00Z'));
      expect(r.wasActive).toBe(false);
      expect(prisma.mcpApiKey.update).toHaveBeenCalledWith({ where: { id: 'sk-1' }, data: { isActive: false, expiresAt: past } });
    });

    it('lists support keys only, optionally the active ones', async () => {
      const prisma = fakePrisma();
      const now = new Date('2026-11-06T12:00:00Z');
      await listSupportKeys(prisma, { activeOnly: true, now });
      expect(prisma.mcpApiKey.findMany.mock.calls[0][0].where).toEqual({ isSupport: true, isActive: true, expiresAt: { gt: now } });
      await listSupportKeys(prisma);
      expect(prisma.mcpApiKey.findMany.mock.calls[1][0].where).toEqual({ isSupport: true });
    });
  });

  describe('command', () => {
    const io = (answer = false) => {
      const lines: string[] = [];
      return { lines, io: { out: (l: string) => lines.push(l), confirm: jest.fn().mockResolvedValue(answer) } };
    };

    it('parses flags and positionals', () => {
      expect(parseArgs(['mint', '--user', 'a@b', '--yes', '--ttl', '2h'])).toEqual({
        command: 'mint', positional: [], flags: { user: 'a@b', yes: true, ttl: '2h' },
      });
      expect(parseArgs(['revoke', 'sk-1'])).toEqual({ command: 'revoke', positional: ['sk-1'], flags: {} });
    });

    it('shows the target and mints nothing when the operator says no', async () => {
      const prisma = fakePrisma();
      const { lines, io: cli } = io(false);
      const code = await runSupportKeysCli(['mint', '--user', 'ana@acme.test', '--operator', 'matteo'], prisma, cli);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('workspace  Acme (org-1)');
      expect(lines.join('\n')).toContain('user       ana@acme.test (role EDITOR)');
      expect(lines).toContain('Nothing minted.');
      expect(prisma.mcpApiKey.create).not.toHaveBeenCalled();
    });

    it('mints after confirmation and prints the key once', async () => {
      const prisma = fakePrisma();
      const { lines, io: cli } = io(true);
      const code = await runSupportKeysCli(['mint', '--user', 'ana@acme.test', '--operator', 'matteo', '--scope', 'MANAGEMENT_READ'], prisma, cli);
      expect(code).toBe(0);
      const keyLines = lines.filter((l) => /mcp_[0-9a-f]{64}/.test(l));
      expect(keyLines).toHaveLength(1);
      expect(prisma.mcpApiKey.create.mock.calls[0][0].data.scope).toBe('MANAGEMENT_READ');
    });

    it('skips the question with --yes', async () => {
      const prisma = fakePrisma();
      const { io: cli } = io(false);
      expect(await runSupportKeysCli(['mint', '--user', 'ana@acme.test', '--operator', 'matteo', '--yes'], prisma, cli)).toBe(0);
      expect(cli.confirm).not.toHaveBeenCalled();
    });

    it('lists with a state per key and prints usage for an unknown command', async () => {
      const prisma = fakePrisma();
      const now = Date.now();
      prisma.mcpApiKey.findMany.mockResolvedValue([
        { id: 'a', name: 'support:m:1', scope: 'MCP', isActive: true, createdAt: new Date(now - 1000), expiresAt: new Date(now + 60_000), lastUsedAt: null, organizationId: 'o', mcpServerId: null, user: { email: 'x@y' } },
        { id: 'b', name: 'support:m:2', scope: 'MCP', isActive: true, createdAt: new Date(now - 9000), expiresAt: new Date(now - 1000), lastUsedAt: null, organizationId: 'o', mcpServerId: 's', user: { email: 'x@y' } },
        { id: 'c', name: 'support:m:3', scope: 'MCP', isActive: false, createdAt: new Date(now - 9000), expiresAt: new Date(now - 1000), lastUsedAt: null, organizationId: 'o', mcpServerId: null, user: { email: 'x@y' } },
      ]);
      const { lines, io: cli } = io();
      expect(await runSupportKeysCli(['list'], prisma, cli)).toBe(0);
      expect(lines[0]).toMatch(/^a {2}ACTIVE/);
      expect(lines[1]).toMatch(/^b {2}expired/);
      expect(lines[2]).toMatch(/^c {2}revoked/);

      const usage = io();
      expect(await runSupportKeysCli(['nope'], prisma, usage.io)).toBe(2);
      expect(usage.lines[0]).toMatch(/^Usage:\n {2}mint --user/);
    });
  });
});
