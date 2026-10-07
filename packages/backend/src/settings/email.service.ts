import { Injectable, Logger, Optional } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import { SiteSettingsService } from './site-settings.service';
import { OrgSettingsService } from './org-settings.service';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { TrustStatsService } from '../public-stats/trust-stats.service';
import { EMPTY_TRUST_STATS, TrustStats, formatTrustStats } from '../public-stats/trust-stats.format';
import type { EmailBrandContext } from './email-layout';
import {
  MarketingContext,
  RenderedEmail,
  WinbackOffer,
  activationReminderEmail,
  existingAccountEmail,
  invitationEmail,
  licenseKeyEmail,
  onboardingReminderEmail,
  passwordResetEmail,
  trialLifecycleEmail,
  trialWinbackEmail,
  verificationEmail,
} from './email-templates';
import { buildUnsubscribeUrl, unsubscribeSecret } from './unsubscribe-token';

/** The longest an email waits for the trust numbers before going out without fresh ones. */
const STATS_WAIT_MS = 3000;

// Production always talks to anythingmcp.com. The licence site decides
// which plan an installation runs; a URL taken from the environment would let
// any self-hosted operator point verification at a server of their own and
// unlock paid features. LICENSE_API_URL applies outside production only (local
// end-to-end runs against a local licence site).
const LICENSE_API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://anythingmcp.com'
    : process.env.LICENSE_API_URL?.replace(/\/+$/, '') || 'http://localhost:3100';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(
    private readonly siteSettings: SiteSettingsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    @Optional() private readonly trustStats?: TrustStatsService,
  ) {}

  /** Trust numbers and deployment claims for the shared layout. Never throws. */
  private async brand(): Promise<EmailBrandContext> {
    let stats: TrustStats = EMPTY_TRUST_STATS;
    if (this.trustStats) {
      stats = await Promise.race([
        this.trustStats.get().catch(() => this.trustStats!.peek()),
        new Promise<TrustStats>((resolve) =>
          setTimeout(() => resolve(this.trustStats!.peek()), STATS_WAIT_MS).unref?.(),
        ),
      ]);
    }
    return { stats: formatTrustStats(stats), cloud: this.deployment.isCloud() };
  }

  private cloudUrl(): string {
    return (process.env.CLOUD_PUBLIC_URL || 'https://cloud.anythingmcp.com').replace(/\/+$/, '');
  }

  private marketingUrl(): string {
    return (process.env.MARKETING_URL || 'https://anythingmcp.com').replace(/\/+$/, '');
  }

  /**
   * Context for a marketing email: the layout's, plus a signed one-click
   * unsubscribe link for this recipient (RFC 8058) and the headers that
   * advertise it. Without a signing secret or a matching account, the footer
   * falls back to the account settings and no one-click header is sent.
   */
  private async marketing(to: string): Promise<{ ctx: MarketingContext; headers: Record<string, string> }> {
    const base = await this.brand();
    const cloudUrl = this.cloudUrl();
    const secret = unsubscribeSecret();
    const user = secret
      ? await this.prisma.user
          .findUnique({ where: { email: to }, select: { id: true } })
          .catch(() => null)
      : null;
    if (secret && user) {
      const url = buildUnsubscribeUrl(cloudUrl, user.id, secret);
      return {
        ctx: { ...base, unsubscribeUrl: url },
        headers: {
          'List-Unsubscribe': `<${url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      };
    }
    const settingsUrl = `${cloudUrl}/settings#email-preferences`;
    return { ctx: { ...base, unsubscribeUrl: settingsUrl }, headers: { 'List-Unsubscribe': `<${settingsUrl}>` } };
  }

  /** nodemailer fields for a rendered email. */
  private mail(email: RenderedEmail, headers?: Record<string, string>) {
    return {
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(headers ? { headers } : {}),
    };
  }

  /**
   * Build a transport with aggressive timeouts. Cloud droplets black-hole the
   * standard SMTP ports (25/465/587), and nodemailer's default connection
   * timeout is 2 minutes — a misconfigured workspace SMTP made requests hang
   * for many minutes (one real test clocked 16 min). 10s is plenty for any
   * reachable server.
   */
  private buildTransport(smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  }) {
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  private normalizeSmtp(raw: any) {
    if (!raw || !raw.host) return null;
    return {
      host: String(raw.host),
      port: Number(raw.port) || 587,
      secure: !!raw.secure,
      user: raw.user ?? '',
      pass: raw.pass ?? '',
      from: raw.from,
    };
  }

  /**
   * System (operator) SMTP from ENV — the transactional fallback (e.g. Resend)
   * used when an org hasn't configured its own SMTP. Read ONLY here and never
   * returned by any API, so our credentials are never exposed to workspace
   * admins. Configure on the server via SMTP_HOST/PORT/USER/PASS/FROM/SECURE.
   */
  private systemSmtp() {
    const host = process.env.SMTP_HOST;
    if (!host) return null;
    const port = Number(process.env.SMTP_PORT) || 587;
    return this.normalizeSmtp({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from:
        process.env.SMTP_FROM ||
        (process.env.SMTP_USER ? `AnythingMCP <${process.env.SMTP_USER}>` : 'AnythingMCP'),
    });
  }

  /**
   * The org's own SMTP config, or null. Never falls back — callers decide
   * what to do when the workspace hasn't configured (or has broken) SMTP.
   */
  private async orgSmtp(organizationId?: string) {
    if (!organizationId) return null;
    return this.normalizeSmtp(
      await this.orgSettings.getJson<any>(organizationId, 'smtp_config'),
    );
  }

  /**
   * Operator/instance-level SMTP: the legacy site-settings config (self-hosted
   * installs configured pre-multi-org), then the env-based system fallback
   * (e.g. Resend/Mailgun on cloud). Read only server-side and never returned
   * by any API, so operator credentials are never exposed to workspace admins.
   */
  private async instanceSmtp() {
    const site = this.normalizeSmtp(await this.siteSettings.getSmtpConfig());
    return site || this.systemSmtp();
  }

  /**
   * Resolve the SMTP to send with: the ORG's own SMTP first, then the
   * instance/system fallback. Returns null if neither is set (callers then
   * use the external-API fallback or skip).
   */
  private async resolveSmtp(organizationId?: string) {
    return (await this.orgSmtp(organizationId)) || this.instanceSmtp();
  }

  // ── Password Reset (SMTP with external API fallback) ─────────────────────

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
  ): Promise<boolean> {
    const smtp = await this.instanceSmtp();

    if (smtp) {
      try {
        const transporter = this.buildTransport(smtp);

        await transporter.sendMail({
          from: smtp.from || `AnythingMCP <${smtp.user}>`,
          to,
          ...this.mail(passwordResetEmail({ resetUrl }, await this.brand())),
        });

        this.logger.log(`Password reset email sent to ${to}`);
        return true;
      } catch (err) {
        this.logger.error(`Failed to send password reset via SMTP to ${to}: ${err}`);
        return false;
      }
    }

    // Fallback: send via external API (requires active license)
    let licenseKey = await this.siteSettings.get('license_key');
    if (!licenseKey) {
      const activeLicense = await this.prisma.license.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        select: { licenseKey: true },
      });
      if (activeLicense) licenseKey = activeLicense.licenseKey;
    }
    if (!licenseKey) {
      this.logger.warn(
        `SMTP not configured and no license key available — cannot send password reset to ${to}`,
      );
      return false;
    }
    this.logger.log(
      `SMTP not configured, using external API fallback for password reset to ${to}`,
    );
    return this.sendViaExternalApi('/api/email/password-reset', {
      email: to,
      resetUrl,
      licenseKey,
    });
  }

  // ── Invitation Email (SMTP with external API fallback) ────────────────────

  private async createTransporter(organizationId?: string) {
    const smtp = await this.resolveSmtp(organizationId);
    if (!smtp) return null;
    return {
      transporter: this.buildTransport(smtp),
      from: smtp.from || `AnythingMCP <${smtp.user}>`,
    };
  }

  /**
   * Transports to try in order for org-scoped mail: the workspace's own SMTP
   * first, then the instance/system fallback. A broken workspace SMTP must
   * never black-hole an invitation — the mail still goes out via the
   * platform sender and the admin gets told their SMTP failed.
   */
  private async transportCandidates(organizationId?: string) {
    const candidates: Array<{
      transporter: nodemailer.Transporter;
      from: string;
      source: 'workspace' | 'system';
    }> = [];
    const org = await this.orgSmtp(organizationId);
    if (org) {
      candidates.push({
        transporter: this.buildTransport(org),
        from: org.from || `AnythingMCP <${org.user}>`,
        source: 'workspace',
      });
    }
    const instance = await this.instanceSmtp();
    if (instance) {
      candidates.push({
        transporter: this.buildTransport(instance),
        from: instance.from || `AnythingMCP <${instance.user}>`,
        source: 'system',
      });
    }
    return candidates;
  }

  async sendInvitationEmail(
    to: string,
    inviteUrl: string,
    invitedByName: string,
    roleName: string,
    organizationId?: string,
  ): Promise<{ sent: boolean; error?: string }> {
    const candidates = await this.transportCandidates(organizationId);
    let workspaceError: string | undefined;
    const email = candidates.length
      ? invitationEmail({ inviteUrl, invitedByName, roleName }, await this.brand())
      : null;

    for (const transport of candidates) {
      try {
        await transport.transporter.sendMail({
          from: transport.from,
          to,
          ...this.mail(email!),
        });

        this.logger.log(`Invitation email sent to ${to} (via ${transport.source} SMTP)`);
        return {
          sent: true,
          ...(workspaceError
            ? {
                error: `Your workspace SMTP failed (${workspaceError}) — the invitation was delivered by the platform mail service instead.`,
              }
            : {}),
        };
      } catch (err: any) {
        this.logger.error(
          `Failed to send invitation via ${transport.source} SMTP to ${to}: ${err}`,
        );
        if (transport.source === 'workspace') {
          workspaceError = err.message || 'SMTP delivery failed';
        } else {
          return { sent: false, error: err.message || 'SMTP delivery failed' };
        }
      }
    }
    // No SMTP delivered it (none configured, or workspace SMTP failed with no
    // system fallback) — try the external API (requires active license).
    let licenseKey = await this.siteSettings.get('license_key');
    if (!licenseKey) {
      const activeLicense = await this.prisma.license.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        select: { licenseKey: true },
      });
      if (activeLicense) licenseKey = activeLicense.licenseKey;
    }
    this.logger.log(
      `Using external API fallback for invitation (licenseKey ${licenseKey ? 'present' : 'MISSING'})`,
    );
    const result = await this.sendViaExternalApiWithError('/api/email/invite', {
      email: to,
      inviterName: invitedByName,
      instanceUrl: inviteUrl,
      ...(licenseKey ? { licenseKey } : {}),
    });
    if (workspaceError) {
      return result.sent
        ? {
            sent: true,
            error: `Your workspace SMTP failed (${workspaceError}) — the invitation was delivered by the platform mail service instead.`,
          }
        : { sent: false, error: workspaceError };
    }
    return result;
  }

  // ── Welcome Email (SMTP with external API fallback) ───────────────────────

  async sendWelcomeEmail(
    to: string,
    name: string,
    licenseKey: string,
  ): Promise<boolean> {
    const transport = await this.createTransporter();

    if (transport) {
      try {
        await transport.transporter.sendMail({
          from: transport.from,
          to,
          ...this.mail(licenseKeyEmail({ name, licenseKey }, await this.brand())),
        });

        this.logger.log(`Welcome email sent to ${to}`);
        return true;
      } catch (err) {
        this.logger.error(`Failed to send welcome email via SMTP to ${to}: ${err}`);
        return false;
      }
    }

    // Fallback: send via external API
    return this.sendViaExternalApi('/api/email/welcome', {
      email: to,
      name,
      licenseKey,
    });
  }

  // ── Verification Email (SMTP with external API fallback) ─────────────────

  async sendVerificationEmail(
    to: string,
    code: string,
    verifyUrl: string,
  ): Promise<boolean> {
    const transport = await this.createTransporter();

    if (!transport) {
      // No local SMTP configured — we will fall back to the external API
      // (anythingmcp.com mailer). Don't log the verification code: even
      // with redaction filters, a 6-digit code is short enough to be a
      // genuine credential and ends up readable by anyone with log access
      // (cloud provider, sysadmin, leaked dump). The fallback path below
      // delivers the code via Mailgun.
      this.logger.debug(
        `Local SMTP not configured for ${to}; delegating verification email to external API.`,
      );
    }

    if (transport) {
      try {
        await transport.transporter.sendMail({
          from: transport.from,
          to,
          ...this.mail(verificationEmail({ code, verifyUrl }, await this.brand())),
        });

        this.logger.log(`Verification email sent to ${to}`);
        return true;
      } catch (err) {
        this.logger.error(
          `Failed to send verification email via SMTP to ${to}: ${err}`,
        );
      }
    }

    // Fallback: send via external API
    return this.sendViaExternalApi('/api/email/verify', {
      email: to,
      code,
      verifyUrl,
    });
  }

  // ── Sign-up with an address that already has an account (SMTP only) ────
  // Registration answers the same whether or not the address is taken, so the
  // owner of an existing account hears about the attempt here instead. Cloud
  // has system SMTP; without SMTP this is skipped.

  async sendExistingAccountEmail(
    to: string,
    loginUrl: string,
    resetUrl: string,
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn('SMTP not configured; existing-account notice not sent.');
      return false;
    }
    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        ...this.mail(existingAccountEmail({ loginUrl, resetUrl }, await this.brand())),
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to send existing-account notice: ${err}`);
      return false;
    }
  }

  // ── Onboarding Reminder (SMTP only) ───────────────────────────────────
  // Cloud-only drip. Self-hosted instances generally don't have SMTP set
  // up and the external website API has no template for it, so we skip
  // rather than throw.

  async sendOnboardingReminderEmail(
    to: string,
    name: string,
    dayNumber: 1 | 2,
    /** Set when the user already connected an AI client to the empty workspace. */
    opts?: { aiClient?: string },
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(
        `Skipping onboarding-reminder email to ${to}: no SMTP configured`,
      );
      return false;
    }

    const { ctx, headers } = await this.marketing(to);
    const email = onboardingReminderEmail(
      { name, dayNumber, aiClient: opts?.aiClient, cloudUrl: this.cloudUrl() },
      ctx,
    );

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        ...this.mail(email, headers),
      });
      this.logger.log(
        `Onboarding-reminder email (day ${dayNumber}${opts?.aiClient ? ', AI client connected' : ''}) sent to ${to}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to send onboarding-reminder email to ${to}: ${err}`,
      );
      return false;
    }
  }

  /**
   * Trial lifecycle (cloud-only, SMTP-only): value-oriented nudges as the trial
   * winds down. Unlike the activation drip, these connect what the user has
   * BUILT to the upgrade. Stages: warn3 (~3 days left), warn1 (last day),
   * expired (trial over, data preserved). Returns false if no SMTP (skipped).
   * Lifecycle, not marketing: the cron sends them regardless of the marketing
   * opt-out, so they carry no unsubscribe line.
   */
  async sendTrialLifecycleEmail(
    to: string,
    name: string,
    stage: 'warn3' | 'warn1' | 'expired',
    recap: { connectors: number; successfulCalls: number; daysLeft: number },
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(`Skipping trial-${stage} email to ${to}: no SMTP configured`);
      return false;
    }

    const email = trialLifecycleEmail(
      { name, stage, recap, cloudUrl: this.cloudUrl(), marketingUrl: this.marketingUrl() },
      await this.brand(),
    );

    try {
      await transport.transporter.sendMail({ from: transport.from, to, ...this.mail(email) });
      this.logger.log(`Trial-${stage} email sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send trial-${stage} email to ${to}: ${err}`);
      return false;
    }
  }

  // ── Activation Reminder (SMTP only) ───────────────────────────────────
  // Sent once to a user who built a connector but never got a single
  // successful tool call — the biggest drop-off point. Links straight to
  // their connector so they can run a test in one click.

  async sendActivationReminderEmail(
    to: string,
    name: string,
    connectorPath: string,
    variant: 'connect-client' | 'test-connector' = 'test-connector',
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(
        `Skipping activation-reminder email to ${to}: no SMTP configured`,
      );
      return false;
    }

    const { ctx, headers } = await this.marketing(to);
    const email = activationReminderEmail(
      { name, connectorUrl: `${this.cloudUrl()}${connectorPath}`, variant },
      ctx,
    );

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        ...this.mail(email, headers),
      });
      this.logger.log(`Activation-reminder email sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to send activation-reminder email to ${to}: ${err}`,
      );
      return false;
    }
  }

  /**
   * Win-back after a Cloud trial ended (onboarding cron). Someone who used the
   * product gets a discount code; someone who never made a call gets the
   * shortest way to a first result instead, since a discount does not help
   * with a product they never saw work. Marketing: the caller honours the
   * opt-out.
   */
  async sendTrialWinbackEmail(
    to: string,
    name: string,
    offer: WinbackOffer,
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(`Skipping trial win-back email to ${to}: no SMTP configured`);
      return false;
    }

    const { ctx, headers } = await this.marketing(to);
    const email = trialWinbackEmail(
      { name, offer, cloudUrl: this.cloudUrl(), marketingUrl: this.marketingUrl() },
      ctx,
    );

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        ...this.mail(email, headers),
      });
      this.logger.log(`Trial win-back (${offer.kind}) email sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send trial win-back email to ${to}: ${err}`);
      return false;
    }
  }

  // ── External API Fallback ─────────────────────────────────────────────────

  private async sendViaExternalApi(
    endpoint: string,
    body: Record<string, string>,
  ): Promise<boolean> {
    try {
      await axios.post(`${this.apiBase}${endpoint}`, body, {
        timeout: 10000,
      });
      this.logger.log(
        `Email sent via external API: ${endpoint} to ${body.email}`,
      );
      return true;
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.error(
        `Failed to send email via external API ${endpoint} (${err.response?.status || 'N/A'}): ${detail}`,
      );
      return false;
    }
  }

  private async sendViaExternalApiWithError(
    endpoint: string,
    body: Record<string, string>,
  ): Promise<{ sent: boolean; error?: string }> {
    try {
      await axios.post(`${this.apiBase}${endpoint}`, body, {
        timeout: 10000,
      });
      this.logger.log(
        `Email sent via external API: ${endpoint} to ${body.email}`,
      );
      return { sent: true };
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.error(
        `Failed to send email via external API ${endpoint} (${err.response?.status || 'N/A'}): ${detail}`,
      );
      return { sent: false, error: detail };
    }
  }

  // ── SMTP Test ─────────────────────────────────────────────────────────────

  async testConnection(organizationId?: string): Promise<{ ok: boolean; message: string }> {
    // Test the WORKSPACE config only — testing the hidden system fallback
    // would report "successful" for settings the admin never entered.
    const smtp = await this.orgSmtp(organizationId);
    const hasFallback = !!(await this.instanceSmtp());

    if (!smtp) {
      return hasFallback
        ? {
            ok: true,
            message:
              'No workspace SMTP configured — emails are delivered by the platform mail service.',
          }
        : { ok: false, message: 'SMTP not configured' };
    }

    try {
      await this.buildTransport(smtp).verify();
      return { ok: true, message: 'SMTP connection successful' };
    } catch (err: any) {
      let message = err.message || 'Connection failed';
      if (
        this.deployment.isCloud() &&
        [25, 465, 587].includes(smtp.port) &&
        /timeout|ETIMEDOUT|ECONNREFUSED/i.test(message)
      ) {
        message +=
          ' — note: the cloud network blocks outbound SMTP ports 25/465/587. Use a provider that supports port 2525, or remove the workspace SMTP config to send via the platform mail service.';
      } else if (hasFallback) {
        message +=
          ' — emails will fall back to the platform mail service until this is fixed.';
      }
      return { ok: false, message };
    }
  }
}
