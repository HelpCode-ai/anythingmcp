import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Stable event slugs. Strings (not a Prisma enum) so adding one never needs a
 * migration. Grouped by plane, mirroring what an investigation actually asks:
 * who changed the trust anchor, who got in, what were they allowed to do, and
 * which client was authorized.
 */
export const SecurityEvents = {
  // ── Config plane: who changed the trust anchor ──────────────────────────
  IDP_CREATED: 'IDP_CREATED',
  IDP_UPDATED: 'IDP_UPDATED',
  IDP_DELETED: 'IDP_DELETED',
  IDP_SECRET_ROTATED: 'IDP_SECRET_ROTATED',
  IDP_ROLE_MAPPING_CHANGED: 'IDP_ROLE_MAPPING_CHANGED',
  SSO_ENFORCEMENT_CHANGED: 'SSO_ENFORCEMENT_CHANGED',
  RECOVERY_CODES_GENERATED: 'RECOVERY_CODES_GENERATED',
  RECOVERY_CODE_USED: 'RECOVERY_CODE_USED',
  SCIM_ENABLED: 'SCIM_ENABLED',
  SCIM_DISABLED: 'SCIM_DISABLED',
  SCIM_TOKEN_ROTATED: 'SCIM_TOKEN_ROTATED',

  // ── Auth plane: who got in, and who failed to ───────────────────────────
  SSO_LOGIN_SUCCESS: 'SSO_LOGIN_SUCCESS',
  SSO_LOGIN_FAILED: 'SSO_LOGIN_FAILED',
  IDENTITY_LINKED: 'IDENTITY_LINKED',
  IDENTITY_UNLINKED: 'IDENTITY_UNLINKED',
  JIT_PROVISIONED: 'JIT_PROVISIONED',
  /** A bearer token was refused — e.g. an MCP-issued token sent to the dashboard API. */
  TOKEN_REJECTED: 'TOKEN_REJECTED',
  /** A request to /api/scim/v2 carried no valid bearer. */
  SCIM_AUTH_FAILED: 'SCIM_AUTH_FAILED',

  // ── Provisioning plane: what the directory pushed ───────────────────────
  SCIM_USER_PROVISIONED: 'SCIM_USER_PROVISIONED',
  SCIM_USER_UPDATED: 'SCIM_USER_UPDATED',
  SCIM_USER_DEPROVISIONED: 'SCIM_USER_DEPROVISIONED',
  SCIM_USER_REACTIVATED: 'SCIM_USER_REACTIVATED',
  SCIM_GROUP_CREATED: 'SCIM_GROUP_CREATED',
  SCIM_GROUP_DELETED: 'SCIM_GROUP_DELETED',
  SCIM_GROUP_MEMBERSHIP_CHANGED: 'SCIM_GROUP_MEMBERSHIP_CHANGED',

  // ── Authorization plane: what they were allowed to do ───────────────────
  ROLE_CHANGED: 'ROLE_CHANGED',
  LAST_ADMIN_PROTECTION_TRIGGERED: 'LAST_ADMIN_PROTECTION_TRIGGERED',
  MEMBERSHIP_REMOVED_BY_SYNC: 'MEMBERSHIP_REMOVED_BY_SYNC',
  /** One summary row per batch re-sync (mapping edit, SCIM enable, group delete). */
  ROLE_SYNC_BATCH_COMPLETED: 'ROLE_SYNC_BATCH_COMPLETED',
  /** An admin or a directory push removed this member's access to one workspace. */
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  /** An admin removed a multi-workspace user from ONE workspace (account kept). */
  MEMBERSHIP_REMOVED: 'MEMBERSHIP_REMOVED',
  /** A sign-in rewrote the user's roles from the directory's claims. */
  ROLE_SYNC_APPLIED: 'ROLE_SYNC_APPLIED',
  /** Claims were incomplete, so roles were deliberately left untouched. */
  ROLE_SYNC_SKIPPED: 'ROLE_SYNC_SKIPPED',
  ROLE_SYNC_FAILED: 'ROLE_SYNC_FAILED',
  /** Every token issued before now was invalidated for this user. */
  SESSIONS_REVOKED: 'SESSIONS_REVOKED',
  API_KEY_DEACTIVATED: 'API_KEY_DEACTIVATED',

  // ── Consent plane: which AI client was authorized, by whom ──────────────
  CONSENT_GRANTED: 'CONSENT_GRANTED',
  CONSENT_DENIED: 'CONSENT_DENIED',
  DCR_CLIENT_REGISTERED: 'DCR_CLIENT_REGISTERED',
} as const;

export type SecurityEventName =
  (typeof SecurityEvents)[keyof typeof SecurityEvents];

export type SecurityActorType = 'USER' | 'SYSTEM' | 'ANONYMOUS';

export interface SecurityEventInput {
  event: SecurityEventName | string;
  actorType: SecurityActorType;
  /** Null when the event happens before an org can be resolved. */
  organizationId?: string | null;
  actorUserId?: string | null;
  targetUserId?: string | null;
  /** Redacted before write — see `redact`. */
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Keys whose VALUE must never be persisted. Matched case-insensitively as a
 * substring, so `clientSecret`, `client_secret` and `CLIENT_SECRET` all hit.
 *
 * Note `authorization` is included: it catches a whole `Authorization` header
 * being passed in wholesale.
 */
const REDACTED_KEY_PATTERN =
  /secret|password|passwd|token|assertion|credential|code_verifier|code_challenge|authorization|cookie|private_key|api[-_]?key/i;

const REDACTED = '[REDACTED]';
/**
 * Distinct from REDACTED on purpose. Reusing it for the depth cut-off made
 * every over-nested value read as "a secret was removed here", which sends an
 * investigation looking for a credential that was never there — a role id list
 * one level too deep looked identical to a stripped password.
 */
const TRUNCATED_DEPTH = '[TRUNCATED:depth]';
const MAX_DEPTH = 4;
const MAX_STRING = 512;

/**
 * Append-only audit trail for authentication and authorization events.
 *
 * Deliberately a sibling of `AuditService` rather than an extension of it:
 * `AuditService` writes `tool_invocations`, whose `tool_id` is NOT NULL with an
 * FK to `mcp_tools`, so it structurally cannot host an auth event.
 *
 * Writes are best-effort and NEVER throw: failing to record an event must not
 * be able to break a login or deny a legitimate request.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(input: SecurityEventInput): Promise<void> {
    try {
      await this.prisma.securityEvent.create({
        data: {
          event: input.event,
          actorType: input.actorType,
          organizationId: input.organizationId ?? null,
          actorUserId: input.actorUserId ?? null,
          targetUserId: input.targetUserId ?? null,
          metadata: (this.redact(input.metadata) ?? undefined) as any,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, MAX_STRING) ?? null,
        },
      });
    } catch (error: any) {
      // Never propagate: an audit failure must not deny a legitimate request,
      // and must not hand an attacker a way to break the flow by breaking the
      // write. Surfaced in the logs so it is still noticed.
      this.logger.error(
        `Failed to persist security event '${input.event}': ${error?.message}`,
      );
    }
  }

  /**
   * Recursively replaces sensitive values. Depth- and length-bounded so a
   * hostile or accidental payload (a 7 KB groups claim, a nested id_token)
   * cannot bloat the row.
   */
  private redact(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;

    if (depth >= MAX_DEPTH) return TRUNCATED_DEPTH;

    if (typeof value === 'string') {
      return value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}…[truncated]`
        : value;
    }

    if (typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => this.redact(v, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEY_PATTERN.test(key)
        ? REDACTED
        : this.redact(val, depth + 1);
    }
    return out;
  }
}
