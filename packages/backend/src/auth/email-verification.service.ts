import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { UsersService } from '../users/users.service';
import { EmailService } from '../settings/email.service';
import { LicenseService } from '../license/license.service';
import { AdsSignupService } from '../audit/ads-signup.service';
import { maskEmail } from './mcp-email-verification';

/** How long a verification code (and its link) stays valid. */
export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;

/** At most this many codes per user per hour (POST /api/auth/resend-verification). */
export const MAX_CODES_PER_HOUR = 5;

/**
 * The email verification codes: issuing one, checking one, and what a
 * verified address unlocks (the Cloud trial, the ChatGPT Ads report).
 *
 * Used by the dashboard endpoints (AuthController: sign-up, sign-in, verify,
 * resend) and by the MCP authorization page (LoginController), which asks an
 * unverified Cloud account for its code before "Approve". Both must behave
 * the same, so the logic lives here once.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly licenseService: LicenseService,
    @Optional() private readonly adsSignup?: AdsSignupService,
  ) {}

  private frontendUrl(): string {
    // Server-side config only: request headers are attacker-controlled and
    // end up in the email's HTML.
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    );
  }

  /**
   * Voids the user's open codes, issues a new one and emails it. Resolves to
   * whether the email went out (always true with `sendInBackground`).
   */
  async sendCode(userId: string, email: string, opts: { sendInBackground?: boolean } = {}): Promise<boolean> {
    // Invalidate old tokens
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generate 6-digit code + UUID link token
    const code = crypto.randomInt(100000, 1000000).toString();
    const linkToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await this.prisma.emailVerificationToken.create({
      data: { userId, token: linkToken, code, expiresAt },
    });

    // Link straight to the instance's verify-email page (the anythingmcp.com
    // hop 404s behind the marketing site's i18n middleware).
    const verifyUrl = `${this.frontendUrl()}/verify-email?token=${linkToken}`;

    const send = this.emailService.sendVerificationEmail(email, code, verifyUrl).catch((err) => {
      this.logger.error(`Failed to send verification email to ${maskEmail(email)}: ${err}`);
      return false;
    });
    // The code exists either way; only the delivery is left running.
    if (opts.sendInBackground) return true;
    return send;
  }

  /** How many codes this user was sent in the last `withinMs`. */
  async codesSentWithin(userId: string, withinMs: number): Promise<number> {
    return this.prisma.emailVerificationToken.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - withinMs) } },
    });
  }

  /**
   * Checks a 6-digit code against the user's open, unexpired codes. On a match
   * the code is spent and the address verified (see markVerified).
   */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const record = await this.prisma.emailVerificationToken.findFirst({
      where: {
        userId,
        code,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!record) return false;

    await this.prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await this.markVerified(userId);
    return true;
  }

  /** The address is proven: mark it, then what follows a verification on Cloud. */
  async markVerified(userId: string): Promise<void> {
    await this.usersService.update(userId, { emailVerified: true });

    // Cloud: deterministically ensure the workspace has a trial before any
    // license gate evaluates (best-effort; never blocks verification).
    await this.ensureCloudTrial(userId);

    // Cloud, ChatGPT Ads sign-ups only: report the verified sign-up (in the
    // background; never blocks verification).
    void this.adsSignup?.onEmailVerified(userId);
  }

  /**
   * Cloud only: make sure a freshly-verified user's workspace has a trial
   * license, idempotently and best-effort. This removes the client-side race
   * where a failed trial activation in the login flow dropped the user onto the
   * "no-license" wall instead of onboarding. Never throws — verification must
   * succeed regardless; the login flow + LicenseWall "Start trial" CTA remain
   * as fallbacks.
   */
  private async ensureCloudTrial(userId: string): Promise<void> {
    const isCloud = this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';
    if (!isCloud) return;
    try {
      const user = await this.usersService.findById(userId);
      if (!user?.organizationId) return;
      // Idempotent: skip if this org already has any license (trial or paid).
      const existing = await this.prisma.license.findFirst({
        where: { organizationId: user.organizationId },
      });
      if (existing) return;
      await this.licenseService.requestTrialLicense(
        user.email,
        user.name || user.email,
        user.organizationId,
      );
      this.logger.log(`Cloud trial activated for org ${user.organizationId} on email verification.`);
    } catch (err: any) {
      this.logger.warn(`Cloud trial activation on verify failed for user ${userId}: ${err.message}`);
    }
  }
}
