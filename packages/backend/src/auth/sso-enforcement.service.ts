import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Answers one question: may this user still sign in with a password?
 *
 * The check spans EVERY organization the user belongs to, not just the active
 * one. `POST /api/organizations/switch` moves a session between workspaces, so
 * a password that opens a session in a permissive org and is then switched into
 * an enforcing one would defeat the control entirely. Failing closed across all
 * memberships is the only version of this that actually enforces anything.
 */
@Injectable()
export class SsoEnforcementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Organizations of this user that require SSO. Empty means password is fine. */
  async enforcingOrganizations(userId: string): Promise<string[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    if (memberships.length === 0) return [];

    const providers = await this.prisma.identityProvider.findMany({
      where: {
        organizationId: { in: memberships.map((m) => m.organizationId) },
        enforceSso: true,
        // An inactive provider cannot be signed in through, so treating it as
        // enforcing would lock the workspace out with no way to notice why.
        isActive: true,
      },
      select: { organizationId: true },
    });
    return [...new Set(providers.map((p) => p.organizationId))];
  }

  async isPasswordLoginBlocked(userId: string): Promise<boolean> {
    return (await this.enforcingOrganizations(userId)).length > 0;
  }
}
