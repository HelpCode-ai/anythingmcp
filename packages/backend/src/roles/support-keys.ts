import { randomBytes } from 'crypto';
import { apiKeySuffix, hashApiKey } from '../common/crypto/api-key-hash.util';
import type { McpApiKeyScope } from '../generated/prisma/client';

/**
 * Short-lived support keys.
 *
 * An operator mints one on the server (see support-keys.cli.ts) to reproduce
 * an issue as a given user, instead of reading the user's own key. The key:
 *  - authenticates as that user, with the same role, tools and per-user
 *    connector credentials, so a reproduction is faithful;
 *  - expires on its own (default 60 minutes, at most 24 hours) and can be
 *    revoked at once;
 *  - is stored like any key, as a hash only; the clear key is printed once;
 *  - is hidden from the user's key lists, and its tool calls are not written
 *    to the workspace's logs, alerts or usage counters (see AuditService).
 *
 * The key row is the audit record (operator, target, scope, server, created,
 * expires, revoked): it is never deleted. Each tool call made with it also
 * writes one log line, without inputs or outputs.
 *
 * Nothing here is reachable over HTTP. Minting is a cross-tenant power and
 * must stay a server-side command.
 */

export const SUPPORT_KEY_DEFAULT_TTL_MINUTES = 60;
export const SUPPORT_KEY_MAX_TTL_MINUTES = 24 * 60;
const SCOPES: McpApiKeyScope[] = ['MCP', 'MANAGEMENT_READ', 'MANAGEMENT_ADMIN'];

/** True when a key row may no longer authenticate because it has expired. */
export function isKeyExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

/** "45m", "2h", "90" (minutes) → minutes, within 1 minute .. 24 hours. */
export function parseTtlMinutes(value: string | undefined): number {
  if (value === undefined || value === '') return SUPPORT_KEY_DEFAULT_TTL_MINUTES;
  const m = /^(\d+)\s*(m|min|h)?$/i.exec(value.trim());
  if (!m) throw new Error(`Invalid --ttl "${value}": use minutes ("45m", "90") or hours ("2h").`);
  const minutes = Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 60 : 1);
  if (minutes < 1 || minutes > SUPPORT_KEY_MAX_TTL_MINUTES) {
    throw new Error(`--ttl must be between 1 minute and ${SUPPORT_KEY_MAX_TTL_MINUTES / 60} hours.`);
  }
  return minutes;
}

export function parseScope(value: string | undefined): McpApiKeyScope {
  const scope = (value || 'MCP').toUpperCase() as McpApiKeyScope;
  if (!SCOPES.includes(scope)) throw new Error(`Invalid --scope "${value}": use ${SCOPES.join(', ')}.`);
  return scope;
}

/** Operator label stored in the key name: letters, digits, dot, dash, underscore. */
export function parseOperator(value: string | undefined): string {
  const op = (value || '').trim();
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(op)) {
    throw new Error('--operator is required (2-40 letters, digits, ".", "-" or "_"), e.g. --operator matteo.');
  }
  return op;
}

/** The minimal Prisma surface used here, so tests can pass a fake. */
export interface SupportKeysPrisma {
  user: { findUnique(args: any): Promise<any> };
  organizationMember: { findUnique(args: any): Promise<any>; findMany(args: any): Promise<any[]> };
  organization: { findUnique(args: any): Promise<any> };
  mcpServerConfig: { findFirst(args: any): Promise<any> };
  mcpApiKey: {
    create(args: any): Promise<any>;
    findFirst(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
    update(args: any): Promise<any>;
  };
}

export interface SupportKeyRequest {
  email: string;
  /** Workspace id; optional when the user is an active member of one workspace only. */
  workspaceId?: string;
  /** MCP server id or slug in that workspace; omitted = no server binding. */
  server?: string;
  scope: McpApiKeyScope;
  ttlMinutes: number;
  operator: string;
}

/** What will be minted, resolved and checked, shown to the operator before confirming. */
export interface SupportKeyPlan {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
  organizationName: string;
  mcpServerId: string | null;
  mcpServerName: string | null;
  scope: McpApiKeyScope;
  ttlMinutes: number;
  operator: string;
}

/**
 * Resolve and check the target before anything is written: the user exists,
 * is an active member of the workspace, and the server belongs to it.
 */
export async function planSupportKey(prisma: SupportKeysPrisma, req: SupportKeyRequest): Promise<SupportKeyPlan> {
  const email = req.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) throw new Error(`No user with e-mail ${email}.`);

  let organizationId = req.workspaceId?.trim();
  if (!organizationId) {
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: user.id, deactivatedAt: null },
      select: { organizationId: true },
    });
    if (memberships.length !== 1) {
      throw new Error(
        `${email} is an active member of ${memberships.length} workspaces: pass --workspace <id> ` +
          `(${memberships.map((m: any) => m.organizationId).join(', ') || 'none'}).`,
      );
    }
    organizationId = memberships[0].organizationId as string;
  }

  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
    select: { role: true, deactivatedAt: true },
  });
  if (!membership || membership.deactivatedAt) {
    throw new Error(`${email} is not an active member of workspace ${organizationId}.`);
  }
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!org) throw new Error(`No workspace ${organizationId}.`);

  let server: { id: string; name: string } | null = null;
  if (req.server) {
    server = await prisma.mcpServerConfig.findFirst({
      where: { organizationId, OR: [{ id: req.server }, { slug: req.server }] },
      select: { id: true, name: true },
    });
    if (!server) throw new Error(`No MCP server "${req.server}" in workspace ${org.name} (${organizationId}).`);
  }

  return {
    userId: user.id,
    email: user.email,
    role: membership.role,
    organizationId,
    organizationName: org.name,
    mcpServerId: server?.id ?? null,
    mcpServerName: server?.name ?? null,
    scope: req.scope,
    ttlMinutes: req.ttlMinutes,
    operator: req.operator,
  };
}

/** Write the key (hash only) and return the clear key, shown once. */
export async function mintSupportKey(
  prisma: SupportKeysPrisma,
  plan: SupportKeyPlan,
  now: Date = new Date(),
): Promise<{ id: string; key: string; expiresAt: Date; name: string }> {
  const key = `mcp_${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + plan.ttlMinutes * 60_000);
  const name = `support:${plan.operator}:${now.toISOString().slice(0, 16)}Z`;
  const row = await prisma.mcpApiKey.create({
    data: {
      userId: plan.userId,
      organizationId: plan.organizationId,
      mcpServerId: plan.mcpServerId,
      // The plaintext column is still NOT NULL until it is dropped. Store an
      // unusable unique placeholder, never the key: lookups match the hash.
      key: `support_${randomBytes(24).toString('hex')}`,
      keyHash: hashApiKey(key),
      keySuffix: apiKeySuffix(key),
      name,
      scope: plan.scope,
      expiresAt,
      isSupport: true,
    },
    select: { id: true },
  });
  return { id: row.id, key, expiresAt, name };
}

/** Revoke a support key now. Refuses a user's own key. */
export async function revokeSupportKey(prisma: SupportKeysPrisma, id: string, now: Date = new Date()) {
  const row = await prisma.mcpApiKey.findFirst({
    where: { id, isSupport: true },
    select: { id: true, name: true, isActive: true, expiresAt: true },
  });
  if (!row) throw new Error(`No support key ${id}.`);
  const expiresAt = row.expiresAt && row.expiresAt < now ? row.expiresAt : now;
  await prisma.mcpApiKey.update({ where: { id }, data: { isActive: false, expiresAt } });
  return { id: row.id, name: row.name, wasActive: row.isActive && !isKeyExpired(row.expiresAt, now) };
}

/** Support keys, newest first: the internal audit trail. */
export async function listSupportKeys(prisma: SupportKeysPrisma, opts: { activeOnly?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return prisma.mcpApiKey.findMany({
    where: {
      isSupport: true,
      ...(opts.activeOnly ? { isActive: true, expiresAt: { gt: now } } : {}),
    },
    select: {
      id: true,
      name: true,
      scope: true,
      isActive: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      organizationId: true,
      mcpServerId: true,
      user: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
