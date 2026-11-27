import { apiKeyPepper, apiKeyPlaceholder, hashApiKey, isApiKeyPlaceholder } from '../common/crypto/api-key-hash.util';
import { replacePlaintextKeys, runApiKeyPlaceholdersCli } from './api-key-placeholders.cli';

const PEPPER = apiKeyPepper('unit-test-encryption-key-0123456789abcdef');
const OTHER = apiKeyPepper('another-unit-test-encryption-key-9876543210');
const key = (c: string) => `mcp_${c.repeat(64)}`;

type Row = { id: string; key: string; keyHash: string | null };

/** In-memory stand-in for the three Prisma calls the clean-up makes. */
function fakePrisma(rows: Row[]) {
  const matches = (r: Row, where: any) => {
    if (where.id?.gt !== undefined && !(r.id > where.id.gt)) return false;
    if (typeof where.id === 'string' && r.id !== where.id) return false;
    if (where.keyHash === null && r.keyHash !== null) return false;
    if (where.keyHash?.not === null && r.keyHash === null) return false;
    if (typeof where.keyHash === 'string' && r.keyHash !== where.keyHash) return false;
    if (typeof where.key === 'string' && r.key !== where.key) return false;
    if (where.NOT?.some((n: any) => r.key.startsWith(n.key.startsWith))) return false;
    return true;
  };
  const prisma = {
    mcpApiKey: {
      findMany: jest.fn(async ({ where, take }: any) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
    },
  };
  return prisma;
}

function sampleRows(): Row[] {
  return [
    { id: 'a', key: key('a'), keyHash: hashApiKey(key('a'), PEPPER) },
    { id: 'b', key: key('b'), keyHash: hashApiKey(key('b'), PEPPER) },
    // Hash written with another ENCRYPTION_KEY: not verifiable, left alone.
    { id: 'c', key: key('c'), keyHash: hashApiKey(key('c'), OTHER) },
    // Not hashed yet: left alone.
    { id: 'd', key: key('d'), keyHash: null },
    // Already placeholders.
    { id: 'e', key: apiKeyPlaceholder(), keyHash: hashApiKey(key('e'), PEPPER) },
    { id: 'f', key: apiKeyPlaceholder('support'), keyHash: hashApiKey(key('f'), PEPPER) },
  ];
}

describe('api-key-placeholders clean-up', () => {
  it('writes nothing in a dry run and counts what it would change', async () => {
    const rows = sampleRows();
    const before = JSON.stringify(rows);
    const prisma = fakePrisma(rows);
    const counts = await replacePlaintextKeys(prisma, { apply: false, pepper: PEPPER, batchSize: 2 });
    expect(counts).toEqual({ scanned: 3, verified: 2, replaced: 0, hashMismatch: 1, notHashed: 1 });
    expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('replaces only values whose hash verifies, keeping the hash', async () => {
    const rows = sampleRows();
    const prisma = fakePrisma(rows);
    const counts = await replacePlaintextKeys(prisma, { apply: true, pepper: PEPPER, batchSize: 2 });
    expect(counts).toEqual({ scanned: 3, verified: 2, replaced: 2, hashMismatch: 1, notHashed: 1 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(isApiKeyPlaceholder(byId.a.key)).toBe(true);
    expect(isApiKeyPlaceholder(byId.b.key)).toBe(true);
    expect(byId.a.keyHash).toBe(hashApiKey(key('a'), PEPPER));
    expect(byId.c.key).toBe(key('c'));
    expect(byId.d.key).toBe(key('d'));
    // The write is conditional on the values that were checked.
    expect(prisma.mcpApiKey.updateMany).toHaveBeenCalledWith({
      where: { id: 'a', key: key('a'), keyHash: hashApiKey(key('a'), PEPPER) },
      data: { key: expect.stringMatching(/^hashed_[0-9a-f]{48}$/) },
    });
  });

  it('is idempotent', async () => {
    const rows = sampleRows();
    const prisma = fakePrisma(rows);
    await replacePlaintextKeys(prisma, { apply: true, pepper: PEPPER });
    const snapshot = JSON.stringify(rows);
    const again = await replacePlaintextKeys(prisma, { apply: true, pepper: PEPPER });
    expect(again).toEqual({ scanned: 1, verified: 0, replaced: 0, hashMismatch: 1, notHashed: 1 });
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('defaults to a dry run and prints counts only', async () => {
    const rows = sampleRows();
    const prisma = fakePrisma(rows);
    const lines: string[] = [];
    process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-0123456789abcdef';
    const code = await runApiKeyPlaceholdersCli([], prisma, { out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(prisma.mcpApiKey.updateMany).not.toHaveBeenCalled();
    const text = lines.join('\n');
    expect(text).toMatch(/dry run/);
    for (const r of rows) {
      expect(text).not.toContain(r.key);
      if (r.keyHash) expect(text).not.toContain(r.keyHash);
    }
  });

  it('refuses unknown or conflicting arguments without touching the database', async () => {
    const prisma = fakePrisma(sampleRows());
    const out = jest.fn();
    expect(await runApiKeyPlaceholdersCli(['--force'], prisma, { out })).toBe(2);
    expect(await runApiKeyPlaceholdersCli(['--apply', '--dry-run'], prisma, { out })).toBe(2);
    expect(prisma.mcpApiKey.findMany).not.toHaveBeenCalled();
  });
});
