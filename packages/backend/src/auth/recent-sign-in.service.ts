import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AuthService, isTokenRevoked } from './auth.service';
import { SsoEnforcementService } from './sso-enforcement.service';
import { readRecentSignIn } from './recent-sign-in.util';

/** A dashboard session handed out from a recent sign-in. */
export interface RecentSignInSession {
  accessToken: string;
  user: { id: string; email: string; name: string | null; role: string; organizationId: string | null };
}

/**
 * The user behind this browser's recent sign-in on the authorization page
 * (RECENT_SIGN_IN_COOKIE), and dashboard sessions made from it.
 *
 * Someone who has just connected Claude is handed dashboard links by the
 * chat. Without this, each of them asked for the password typed a minute
 * earlier. The cookie is signed, httpOnly and SameSite=Lax, set only after a
 * real sign-in in this browser, so it proves what the dashboard's own 7-day
 * session proves.
 */
@Injectable()
export class RecentSignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly organizations: OrganizationsService,
    private readonly ssoEnforcement: SsoEnforcementService,
    private readonly deployment: DeploymentService,
  ) {}

  /**
   * The user, or null when there is no valid recent sign-in. Also null when
   * "sign out everywhere" came after it, on Cloud without a verified e-mail,
   * and for an account whose workspace requires SSO: the shortcut must not
   * stand in for the IdP's MFA and Conditional Access.
   */
  async user(req: Request): Promise<{ id: string; email: string; name: string | null } | null> {
    const signIn = readRecentSignIn(req);
    if (!signIn) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: signIn.userId },
      select: { id: true, email: true, name: true, emailVerified: true, sessionsValidFrom: true },
    });
    if (!user || isTokenRevoked({ iat: signIn.iat }, user.sessionsValidFrom)) return null;
    if (this.deployment.isCloud() && !user.emailVerified) return null;
    if (await this.ssoEnforcement.isPasswordLoginBlocked(user.id)) return null;
    return { id: user.id, email: user.email, name: user.name };
  }

  /**
   * A dashboard session for the user, on `organizationId` when given (as the
   * workspace menu switches), otherwise on the workspace they last used, or
   * their first active one. Null when they belong to no workspace any more.
   */
  async session(userId: string, organizationId?: string): Promise<RecentSignInSession | null> {
    let target = organizationId;
    if (!target) {
      const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
      const memberships = await this.prisma.organizationMember.findMany({
        where: { userId, deactivatedAt: null },
        select: { organizationId: true },
      });
      target =
        memberships.find((m) => m.organizationId === account?.organizationId)?.organizationId ??
        memberships[0]?.organizationId;
      if (!target) return null;
    }
    const user = await this.organizations.switchOrg(userId, target);
    return {
      accessToken: this.authService.generateToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        mcpRoleId: user.mcpRoleId,
      }),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
    };
  }
}
