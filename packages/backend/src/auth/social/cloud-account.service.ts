import { Injectable, Logger } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { normalizeEmail } from '../../common/email.util';
import { OrganizationsService } from '../../organizations/organizations.service';
import { McpServersService } from '../../mcp-servers/mcp-servers.service';
import { LicenseService } from '../../license/license.service';
import { AuthService } from '../auth.service';

/** The shape `POST /api/auth/login` answers with, so the dashboard treats both the same. */
export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    organizationId: string | null;
    emailVerified: boolean;
  };
  needsLicenseSetup?: true;
}

/**
 * Account creation and session issuing for Cloud sign-ups that do not go
 * through `POST /api/auth/register`.
 *
 * Mirrors what the cloud email sign-up does (`AuthController.createAccount`,
 * `ensureCloudTrial` and the licence part of `login`): a new workspace with
 * the user as its admin, the default MCP server, and the same login response.
 * Kept separate so the social sign-in does not have to reach into the
 * controller; folding the controller onto this service is a follow-up.
 */
@Injectable()
export class CloudAccountService {
  private readonly logger = new Logger(CloudAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly mcpServers: McpServersService,
    private readonly licenses: LicenseService,
    private readonly auth: AuthService,
    private readonly deployment: DeploymentService,
  ) {}

  /**
   * A new workspace whose only member is this user, as ADMIN, with no password.
   * Throws Prisma's P2002 when the address was taken meanwhile; the caller
   * decides what that means.
   */
  async createPasswordlessAccount(input: {
    email: string;
    name: string | null;
    emailVerified: boolean;
  }): Promise<User> {
    const email = normalizeEmail(input.email);
    const name = input.name?.trim() || null;
    const org = await this.organizations.create(`${name || email.split('@')[0]}'s Workspace`);
    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          name,
          passwordHash: null,
          role: 'ADMIN',
          emailVerified: input.emailVerified,
          organizationId: org.id,
        },
      });
      await this.organizations.addMember(user.id, org.id, 'ADMIN' as any);
      await this.mcpServers.createDefaultForUser(user.id, org.id);
      return user;
    } catch (err) {
      // Lost a race for the address: do not leave an empty workspace behind.
      await this.prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Cloud only: give the user's workspace a trial if it has no licence yet.
   * Idempotent, best-effort, never throws. Same as the email verification
   * path, which is the moment a social sign-up corresponds to.
   */
  async ensureCloudTrial(userId: string): Promise<void> {
    if (!this.deployment.isCloud()) return;
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user?.organizationId) return;
      const existing = await this.prisma.license.findFirst({
        where: { organizationId: user.organizationId },
      });
      if (existing) return;
      await this.licenses.requestTrialLicense(user.email, user.name || user.email, user.organizationId);
      this.logger.log(`Cloud trial activated for org ${user.organizationId} on social sign-up.`);
    } catch (err: any) {
      this.logger.warn(`Cloud trial activation failed for user ${userId}: ${err?.message ?? err}`);
    }
  }

  /** The dashboard session for a user, exactly as a password login returns it. */
  async loginResponse(user: User): Promise<LoginResponse> {
    const accessToken = this.auth.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      mcpRoleId: user.mcpRoleId,
    });

    // Only a workspace with no licence at all, current or ended, needs the
    // licence step (see AuthController.login).
    let needsLicenseSetup = false;
    if (user.role === 'ADMIN' && this.deployment.isCloud() && user.organizationId) {
      const current = await this.licenses.getCurrentLicense(user.organizationId);
      const ended = current ? null : await this.licenses.getLatestInactiveLicense(user.organizationId);
      needsLicenseSetup = !current && !ended;
    }

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        emailVerified: user.emailVerified,
      },
      ...(needsLicenseSetup && { needsLicenseSetup: true as const }),
    };
  }
}
