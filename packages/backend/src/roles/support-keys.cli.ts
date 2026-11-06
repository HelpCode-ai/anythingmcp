/**
 * Operator command for short-lived support keys (see support-keys.ts).
 * Runs inside the backend container, with its DATABASE_URL and ENCRYPTION_KEY:
 *
 *   node dist/src/roles/support-keys.cli.js mint --user <email> --operator <name>
 *        [--workspace <id>] [--server <id|slug>] [--scope MCP|MANAGEMENT_READ|MANAGEMENT_ADMIN]
 *        [--ttl 60m] [--yes]
 *   node dist/src/roles/support-keys.cli.js revoke <key id>
 *   node dist/src/roles/support-keys.cli.js list [--active]
 *
 * `mint` shows the resolved target and asks for confirmation unless --yes
 * (run with `docker exec -it` to answer). The key is printed once.
 */
import { createInterface } from 'node:readline/promises';
import { PrismaService } from '../common/prisma.service';
import { apiKeyPepper } from '../common/crypto/api-key-hash.util';
import {
  isKeyExpired,
  listSupportKeys,
  mintSupportKey,
  parseOperator,
  parseScope,
  parseTtlMinutes,
  planSupportKey,
  revokeSupportKey,
  SupportKeysPrisma,
} from './support-keys';

export interface CliIo {
  out: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

export function parseArgs(argv: string[]): { command?: string; positional: string[]; flags: Record<string, string | true> } {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

const USAGE = [
  'Usage:',
  '  mint --user <email> --operator <name> [--workspace <id>] [--server <id|slug>]',
  '       [--scope MCP|MANAGEMENT_READ|MANAGEMENT_ADMIN] [--ttl 60m] [--yes]',
  '  revoke <key id>',
  '  list [--active]',
].join('\n');

/** Runs one command; returns the process exit code. */
export async function runSupportKeysCli(argv: string[], prisma: SupportKeysPrisma, io: CliIo): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  if (command === 'mint') {
    const email = str(flags.user);
    if (!email) throw new Error('--user <email> is required.');
    const plan = await planSupportKey(prisma, {
      email,
      workspaceId: str(flags.workspace),
      server: str(flags.server),
      scope: parseScope(str(flags.scope)),
      ttlMinutes: parseTtlMinutes(str(flags.ttl)),
      operator: parseOperator(str(flags.operator)),
    });
    io.out('Support key to mint:');
    io.out(`  workspace  ${plan.organizationName} (${plan.organizationId})`);
    io.out(`  user       ${plan.email} (role ${plan.role})`);
    io.out(`  server     ${plan.mcpServerName ? `${plan.mcpServerName} (${plan.mcpServerId})` : '(none: not bound to a server)'}`);
    io.out(`  scope      ${plan.scope}`);
    io.out(`  expires in ${plan.ttlMinutes} min`);
    io.out(`  operator   ${plan.operator}`);
    if (flags.yes !== true && !(await io.confirm('Mint this key? [y/N] '))) {
      io.out('Nothing minted.');
      return 1;
    }
    const minted = await mintSupportKey(prisma, plan);
    io.out('');
    io.out(`Key (shown once): ${minted.key}`);
    io.out(`  id ${minted.id}, name ${minted.name}, expires ${minted.expiresAt.toISOString()}`);
    io.out(`  revoke now: revoke ${minted.id}`);
    return 0;
  }

  if (command === 'revoke') {
    const id = positional[0];
    if (!id) throw new Error('revoke needs a key id.');
    const r = await revokeSupportKey(prisma, id);
    io.out(r.wasActive ? `Revoked ${r.id} (${r.name}).` : `${r.id} (${r.name}) was already expired or revoked; marked revoked.`);
    return 0;
  }

  if (command === 'list') {
    const now = new Date();
    const rows = await listSupportKeys(prisma, { activeOnly: flags.active === true, now });
    if (rows.length === 0) io.out('No support keys.');
    for (const r of rows) {
      const state = !r.isActive ? 'revoked' : isKeyExpired(r.expiresAt, now) ? 'expired' : 'ACTIVE';
      io.out(
        [
          r.id,
          state,
          r.name,
          r.scope,
          r.user?.email ?? '-',
          `ws ${r.organizationId}`,
          r.mcpServerId ? `srv ${r.mcpServerId}` : 'no server',
          `created ${r.createdAt.toISOString()}`,
          `expires ${r.expiresAt ? r.expiresAt.toISOString() : '-'}`,
          `last used ${r.lastUsedAt ? r.lastUsedAt.toISOString() : 'never'}`,
        ].join('  '),
      );
    }
    return 0;
  }

  io.out(USAGE);
  return 2;
}

async function main(): Promise<void> {
  // Fail before touching the database if ENCRYPTION_KEY is missing or weak:
  // a key hashed with another pepper would never authenticate.
  apiKeyPepper();
  const prisma = new PrismaService();
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    // Opened only when asking: an interface opened earlier would consume piped
    // input before the question. No answer (closed input) means no.
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
      try {
        return /^y(es)?$/i.test((await Promise.race([rl.question(q), closed])).trim());
      } catch {
        return false;
      } finally {
        rl.close();
      }
    },
  };
  try {
    await prisma.$connect();
    process.exitCode = await runSupportKeysCli(process.argv.slice(2), prisma as unknown as SupportKeysPrisma, io);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
