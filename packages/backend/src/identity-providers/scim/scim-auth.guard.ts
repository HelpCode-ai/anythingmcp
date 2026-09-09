import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../../audit/security-event.service';
import { ScimError } from './scim.errors';
import type { RoleSyncProvider } from '../role-sync.service';
import type { IdentityProviderType, UserRole } from '../../generated/prisma/client';

/** What the SCIM services get to know about the caller. Never the hash. */
export interface ScimProvider extends RoleSyncProvider {
  type: IdentityProviderType;
  jitDefaultRole: UserRole;
  scimLastRequestAt: Date | null;
}

export const SCIM_PROVIDER_SELECT = {
  id: true,
  organizationId: true,
  type: true,
  isActive: true,
  scimEnabled: true,
  scimTokenHash: true,
  scimLastRequestAt: true,
  jitDefaultRole: true,
  roleSyncEnabled: true,
  roleSyncSource: true,
  roleSyncFallback: true,
  roleSyncDefaultRoleIds: true,
} as const;

export function scimTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Write amplification guard for the "last seen" column during Entra bursts. */
const LAST_SEEN_INTERVAL_MS = 60_000;

/**
 * Authenticates a SCIM request by its bearer token and pins the request to
 * ONE identity provider — and therefore one organization.
 *
 * The token is compared by sha256 digest, via a single indexed lookup: an
 * Entra initial cycle sends hundreds of requests in minutes, and bcrypt at
 * cost 12 on each would be both slow and pointless for a 256-bit random
 * secret. `timingSafeEqual` on the digests is belt and braces on top of the
 * index — a B-tree comparison could at most leak bits of the hash, which
 * preimage resistance makes worthless.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const m = typeof header === 'string' ? header.match(/^Bearer\s+(\S+)$/i) : null;
    const token = m?.[1];

    // Malformed or absent: refuse without touching the database or the audit
    // trail. Scanners hit unauthenticated endpoints constantly, and each one
    // must not become a row.
    if (!token || token.length < 16 || token.length > 512) {
      throw new ScimError(401, 'Authentication required');
    }

    const digest = scimTokenHash(token);
    const row = await this.prisma.identityProvider.findUnique({
      where: { scimTokenHash: digest },
      select: SCIM_PROVIDER_SELECT,
    });

    const reason = !row
      ? 'unknown_credential'
      : !row.scimEnabled
        ? 'scim_disabled'
        : !row.isActive
          ? 'provider_inactive'
          : !row.scimTokenHash ||
              !timingSafeEqual(Buffer.from(digest), Buffer.from(row.scimTokenHash))
            ? 'unknown_credential'
            : null;

    if (reason || !row) {
      await this.securityEvents.log({
        event: SecurityEvents.SCIM_AUTH_FAILED,
        actorType: 'ANONYMOUS',
        organizationId: row?.organizationId ?? null,
        metadata: { providerId: row?.id ?? null, reason: reason ?? 'unknown_credential' },
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
      throw new ScimError(401, 'Authentication required');
    }

    const { scimTokenHash: _hash, ...provider } = row;
    req.scimProvider = provider as ScimProvider;

    const last = row.scimLastRequestAt?.getTime() ?? 0;
    if (Date.now() - last > LAST_SEEN_INTERVAL_MS) {
      // Fire-and-forget: a failed bump must never fail the request.
      this.prisma.identityProvider
        .update({ where: { id: row.id }, data: { scimLastRequestAt: new Date() } })
        .catch(() => undefined);
    }
    return true;
  }
}
