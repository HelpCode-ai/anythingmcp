import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import { SiteSettingsService } from './site-settings.service';
import { OrgSettingsService } from './org-settings.service';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';

const LICENSE_API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://anythingmcp.com'
    : 'http://localhost:3100';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(
    private readonly siteSettings: SiteSettingsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

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
          subject: 'Password Reset — AnythingMCP',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #2563eb;">Password Reset</h2>
              <p>You requested a password reset for your AnythingMCP account.</p>
              <p>Click the button below to set a new password. This link expires in 1 hour.</p>
              <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
                Reset Password
              </a>
              <p style="color: #737373; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
              <p style="color: #a3a3a3; font-size: 12px;">AnythingMCP</p>
            </div>
          `,
          text: `Password Reset\n\nYou requested a password reset. Click here to set a new password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
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

    for (const transport of candidates) {
      try {
        await transport.transporter.sendMail({
          from: transport.from,
          to,
          subject: 'You\'ve been invited to AnythingMCP',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #2563eb;">You're Invited!</h2>
              <p><strong>${invitedByName}</strong> has invited you to join the AnythingMCP workspace as <strong>${roleName}</strong>.</p>
              <p>Click the button below to create your account. This invitation expires in 48 hours.</p>
              <a href="${inviteUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
                Accept Invitation
              </a>
              <p style="color: #737373; font-size: 14px;">If you weren't expecting this invite, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
              <p style="color: #a3a3a3; font-size: 12px;">AnythingMCP</p>
            </div>
          `,
          text: `You're Invited!\n\n${invitedByName} has invited you to join AnythingMCP as ${roleName}.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 48 hours.`,
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
          subject: 'Welcome to AnythingMCP — Your License Key',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #2563eb;">Welcome to AnythingMCP!</h2>
              <p>Hi ${name},</p>
              <p>Your license key is:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center; font-family: monospace; font-size: 18px; letter-spacing: 2px; margin: 16px 0;">
                ${licenseKey}
              </div>
              <p>Keep this key safe — you'll need it to activate your AnythingMCP instance.</p>
              <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
              <p style="color: #a3a3a3; font-size: 12px;">AnythingMCP</p>
            </div>
          `,
          text: `Welcome to AnythingMCP!\n\nHi ${name},\n\nYour license key is: ${licenseKey}\n\nKeep this key safe — you'll need it to activate your AnythingMCP instance.`,
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
          subject: 'Verify Your Email — AnythingMCP',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #2563eb;">Verify Your Email</h2>
              <p>Your verification code is:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center; font-family: monospace; font-size: 32px; letter-spacing: 8px; margin: 16px 0; font-weight: bold;">
                ${code}
              </div>
              <p>This code expires in 15 minutes.</p>
              <p>Or click the button below to verify:</p>
              <a href="${verifyUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
                Verify Email
              </a>
              <p style="color: #737373; font-size: 14px;">If you didn't create this account, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
              <p style="color: #a3a3a3; font-size: 12px;">AnythingMCP</p>
            </div>
          `,
          text: `Verify Your Email\n\nYour verification code: ${code}\n\nOr verify here: ${verifyUrl}\n\nThis code expires in 15 minutes.`,
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

  // ── Onboarding Reminder (SMTP only) ───────────────────────────────────
  // Cloud-only drip. Self-hosted instances generally don't have SMTP set
  // up and the external website API has no template for it, so we skip
  // rather than throw.

  async sendOnboardingReminderEmail(
    to: string,
    name: string,
    dayNumber: 1 | 2,
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(
        `Skipping onboarding-reminder email to ${to}: no SMTP configured`,
      );
      return false;
    }

    const cloudUrl =
      process.env.CLOUD_PUBLIC_URL || 'https://cloud.anythingmcp.com';
    const welcomeUrl = `${cloudUrl}/welcome`;
    const unsubUrl = `${cloudUrl}/settings/profile`;

    const subject =
      dayNumber === 1
        ? 'Connect your first tool in 60 seconds — AnythingMCP'
        : 'Still here? Pick a tool to try — AnythingMCP';

    const body =
      dayNumber === 1
        ? `<p>Hi ${name},</p>
           <p>You signed up for AnythingMCP yesterday but haven't connected anything yet. The fastest path to your first AI superpower is picking a ready-made connector from the marketplace — Sendcloud, Stripe, GitHub, Slack, Help Scout… 180+ are pre-wired.</p>
           <p><a href="${welcomeUrl}" style="display:inline-block;background:#d97757;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Open the welcome wizard →</a></p>
           <p style="font-size:13px;color:#666;">Should take about a minute.</p>`
        : `<p>Hi ${name},</p>
           <p>Just checking in — your AnythingMCP account is still waiting for its first connector. If anything got in your way, hit reply and tell us what; we read every reply.</p>
           <p><a href="${welcomeUrl}" style="display:inline-block;background:#d97757;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Pick a connector →</a></p>`;

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        subject,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            ${body}
            <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
            <p style="color: #a3a3a3; font-size: 11px;">
              You're receiving this because you signed up at cloud.anythingmcp.com.
              <a href="${unsubUrl}" style="color: #a3a3a3;">Unsubscribe from these nudges</a>.
            </p>
          </div>
        `,
        text: `Hi ${name},\n\n${
          dayNumber === 1
            ? "You signed up for AnythingMCP yesterday but haven't connected anything yet."
            : 'Your AnythingMCP account is still waiting for its first connector.'
        }\n\nOpen the wizard: ${welcomeUrl}\n\nUnsubscribe: ${unsubUrl}`,
      });
      this.logger.log(
        `Onboarding-reminder email (day ${dayNumber}) sent to ${to}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to send onboarding-reminder email to ${to}: ${err}`,
      );
      return false;
    }
  }

  // ── Activation Reminder (SMTP only) ───────────────────────────────────
  // Sent once to a user who built a connector but never got a single
  // successful tool call — the biggest drop-off point. Links straight to
  // their connector so they can run a test in one click.

  /**
   * Trial lifecycle (cloud-only, SMTP-only): value-oriented nudges as the trial
   * winds down. Unlike the activation drip, these connect what the user has
   * BUILT to the upgrade. Stages: warn3 (~3 days left), warn1 (last day),
   * expired (trial over, data preserved). Returns false if no SMTP (skipped).
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

    const cloudUrl = process.env.CLOUD_PUBLIC_URL || 'https://cloud.anythingmcp.com';
    const marketingUrl = process.env.MARKETING_URL || 'https://anythingmcp.com';
    const pricingUrl = `${marketingUrl}/pricing?return_url=${encodeURIComponent(`${cloudUrl}/settings/license/activate`)}`;

    const built =
      recap.connectors > 0
        ? `You've wired up <strong>${recap.connectors} connector${recap.connectors === 1 ? '' : 's'}</strong>` +
          (recap.successfulCalls > 0
            ? ` and made <strong>${recap.successfulCalls} successful tool call${recap.successfulCalls === 1 ? '' : 's'}</strong>`
            : '') +
          `.`
        : '';

    const subject =
      stage === 'expired'
        ? 'Your AnythingMCP trial has ended — your work is saved'
        : stage === 'warn1'
          ? 'Last day of your AnythingMCP trial'
          : `Your AnythingMCP trial ends in ${recap.daysLeft} days`;

    const intro =
      stage === 'expired'
        ? `<p>Hi ${name},</p>
           <p>Your 7-day trial has ended. ${built} <strong>Nothing was deleted</strong> — your connectors, MCP servers and configuration are preserved. Upgrade to pick up exactly where you left off.</p>`
        : stage === 'warn1'
          ? `<p>Hi ${name},</p>
             <p>Your AnythingMCP trial ends <strong>tomorrow</strong>. ${built} Upgrade now so your agents keep calling your tools without interruption.</p>`
          : `<p>Hi ${name},</p>
             <p>Your AnythingMCP trial ends in <strong>${recap.daysLeft} days</strong>. ${built} Pick a plan to keep it all running.</p>`;

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        ${intro}
        <p><a href="${pricingUrl}" style="display:inline-block;background:#d97757;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">View plans &amp; upgrade →</a></p>
        <p style="font-size:13px;color:#666;">Already have a key? Enter it at <a href="${cloudUrl}/settings/license">${cloudUrl.replace(/^https?:\/\//, '')}/settings/license</a>.</p>
        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
        <p style="color: #a3a3a3; font-size: 11px;">You're receiving this because your workspace is on a trial at cloud.anythingmcp.com.</p>
      </div>
    `;
    const text =
      `Hi ${name},\n\n` +
      (stage === 'expired'
        ? `Your 7-day AnythingMCP trial has ended. Nothing was deleted — your connectors and configuration are preserved. Upgrade to continue.\n\n`
        : stage === 'warn1'
          ? `Your AnythingMCP trial ends tomorrow. Upgrade so your agents keep working.\n\n`
          : `Your AnythingMCP trial ends in ${recap.daysLeft} days. Upgrade to keep it running.\n\n`) +
      `View plans: ${pricingUrl}\nEnter a key: ${cloudUrl}/settings/license`;

    try {
      await transport.transporter.sendMail({ from: transport.from, to, subject, html, text });
      this.logger.log(`Trial-${stage} email sent to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send trial-${stage} email to ${to}: ${err}`);
      return false;
    }
  }

  async sendActivationReminderEmail(
    to: string,
    name: string,
    connectorPath: string,
  ): Promise<boolean> {
    const transport = await this.createTransporter();
    if (!transport) {
      this.logger.warn(
        `Skipping activation-reminder email to ${to}: no SMTP configured`,
      );
      return false;
    }

    const cloudUrl =
      process.env.CLOUD_PUBLIC_URL || 'https://cloud.anythingmcp.com';
    const connectorUrl = `${cloudUrl}${connectorPath}`;
    const unsubUrl = `${cloudUrl}/settings/profile`;

    const subject = "You're one call away — finish setting up your connector";
    const body = `<p>Hi ${name},</p>
      <p>You created a connector in AnythingMCP but it hasn't made a successful call yet. That last step — running one tool — is where everything clicks.</p>
      <p>Open your connector and hit <strong>Run test</strong> on any tool. If it returns an error, the message now tells you exactly what to fix (a missing API key, a wrong URL, etc.).</p>
      <p><a href="${connectorUrl}" style="display:inline-block;background:#d97757;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Test your connector →</a></p>
      <p style="font-size:13px;color:#666;">Stuck? Reply to this email — we read every one.</p>`;

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        subject,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            ${body}
            <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
            <p style="color: #a3a3a3; font-size: 11px;">
              You're receiving this because you signed up at cloud.anythingmcp.com.
              <a href="${unsubUrl}" style="color: #a3a3a3;">Unsubscribe from these nudges</a>.
            </p>
          </div>
        `,
        text: `Hi ${name},\n\nYou created a connector in AnythingMCP but it hasn't made a successful call yet. Open it and hit "Run test" on any tool — error messages now tell you exactly what to fix.\n\nTest your connector: ${connectorUrl}\n\nUnsubscribe: ${unsubUrl}`,
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
