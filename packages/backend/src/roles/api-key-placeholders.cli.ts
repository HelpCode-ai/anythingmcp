/**
 * One-off clean-up: replace the API key values still held in the legacy
 * `mcp_api_keys.key` column with non-secret placeholders.
 *
 * New keys are stored as a hash only (see common/crypto/api-key-hash.util.ts);
 * rows created before that still carry the key itself in `key`. A row is
 * changed only when its `key_hash` is set and equals the hash of the stored
 * value, recomputed here with the instance's ENCRYPTION_KEY: such a row keeps
 * authenticating by hash after the value is gone. Every other row is left as
 * it is and counted. Running it again changes nothing.
 *
 * Runs inside the backend container, with its DATABASE_URL and ENCRYPTION_KEY:
 *
 *   node dist/src/roles/api-key-placeholders.cli.js            # dry run (default)
 *   node dist/src/roles/api-key-placeholders.cli.js --apply    # write
 *
 * Output is counts only; no key, hash or row id is printed.
 */
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  apiKeyPepper,
  apiKeyPlaceholder,
  hashApiKey,
  isApiKeyPlaceholder,
} from '../common/crypto/api-key-hash.util';

/** The minimal Prisma surface used here, so tests can pass a fake. */
export interface ApiKeyPlaceholdersPrisma {
  mcpApiKey: {
    findMany(args: any): Promise<Array<{ id: string; key: string; keyHash: string | null }>>;
    updateMany(args: any): Promise<{ count: number }>;
    count(args: any): Promise<number>;
  };
}

export interface ApiKeyPlaceholderCounts {
  /** Rows whose `key` column holds something other than a placeholder, with a hash set. */
  scanned: number;
  /** Rows whose stored value matches their hash: replaced (or, in a dry run, to replace). */
  verified: number;
  /** Rows actually rewritten (always 0 in a dry run). */
  replaced: number;
  /** Rows whose hash does not match the stored value: left as they are. */
  hashMismatch: number;
  /** Rows without a hash yet: left as they are (the backend hashes them at boot). */
  notHashed: number;
}

const notPlaceholder = [{ key: { startsWith: 'hashed_' } }, { key: { startsWith: 'support_' } }];

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Scans every row once, in id order. Writes only when `apply` is true. */
export async function replacePlaintextKeys(
  prisma: ApiKeyPlaceholdersPrisma,
  opts: { apply: boolean; batchSize?: number; pepper?: Buffer },
): Promise<ApiKeyPlaceholderCounts> {
  const pepper = opts.pepper ?? apiKeyPepper();
  const batchSize = opts.batchSize ?? 500;
  const counts: ApiKeyPlaceholderCounts = {
    scanned: 0,
    verified: 0,
    replaced: 0,
    hashMismatch: 0,
    notHashed: await prisma.mcpApiKey.count({ where: { keyHash: null } }),
  };

  let lastId: string | undefined;
  for (;;) {
    const rows = await prisma.mcpApiKey.findMany({
      where: {
        keyHash: { not: null },
        NOT: notPlaceholder,
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      select: { id: true, key: true, keyHash: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.keyHash || isApiKeyPlaceholder(row.key)) continue;
      counts.scanned++;
      if (!sameHash(hashApiKey(row.key, pepper), row.keyHash)) {
        counts.hashMismatch++;
        continue;
      }
      counts.verified++;
      if (!opts.apply) continue;
      // Conditional on the values just checked, so a row changed meanwhile
      // is left alone.
      const res = await prisma.mcpApiKey.updateMany({
        where: { id: row.id, key: row.key, keyHash: row.keyHash },
        data: { key: apiKeyPlaceholder() },
      });
      counts.replaced += res.count;
    }
    if (rows.length < batchSize) break;
  }
  return counts;
}

export interface CliIo {
  out: (line: string) => void;
}

const USAGE = 'Usage: api-key-placeholders.cli.js [--dry-run | --apply]';

/** Runs the clean-up; returns the process exit code. */
export async function runApiKeyPlaceholdersCli(
  argv: string[],
  prisma: ApiKeyPlaceholdersPrisma,
  io: CliIo,
): Promise<number> {
  const unknown = argv.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length > 0 || (argv.includes('--apply') && argv.includes('--dry-run'))) {
    io.out(USAGE);
    return 2;
  }
  const apply = argv.includes('--apply');
  const c = await replacePlaintextKeys(prisma, { apply });
  io.out(apply ? 'Mode: apply' : 'Mode: dry run (nothing written; pass --apply to write)');
  io.out(`Rows holding a key value, with a hash:      ${c.scanned}`);
  io.out(`  hash matches the value ${apply ? '(replaced)' : '(would be replaced)'}: ${apply ? c.replaced : c.verified}`);
  if (apply && c.replaced !== c.verified) {
    io.out(`  changed meanwhile, left as is:            ${c.verified - c.replaced}`);
  }
  io.out(`  hash does not match, left as is:          ${c.hashMismatch}`);
  io.out(`Rows without a hash yet, left as is:        ${c.notHashed}`);
  return 0;
}

async function main(): Promise<void> {
  // Fail before touching the database if ENCRYPTION_KEY is missing or weak.
  apiKeyPepper();
  const prisma = new PrismaService();
  const io: CliIo = { out: (line) => process.stdout.write(`${line}\n`) };
  try {
    await prisma.$connect();
    process.exitCode = await runApiKeyPlaceholdersCli(
      process.argv.slice(2),
      prisma as unknown as ApiKeyPlaceholdersPrisma,
      io,
    );
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
