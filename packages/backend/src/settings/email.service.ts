import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import { SiteSettingsService } from './site-settings.service';
import { PrismaService } from '../common/prisma.service';

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
    private readonly prisma: PrismaService,
  ) {}

  // ── Password Reset (SMTP with external API fallback) ─────────────────────

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
  ): Promise<boolean> {
    const smtp = await this.siteSettings.getSmtpConfig();

    if (smtp) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: {
            user: smtp.user,
            pass: smtp.pass,
          },
        });

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

  private async createTransporter() {
    const smtp = await this.siteSettings.getSmtpConfig();
    if (!smtp) return null;
    return {
      transporter: nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
      }),
      from: smtp.from || `AnythingMCP <${smtp.user}>`,
    };
  }

  async sendInvitationEmail(
    to: string,
    inviteUrl: string,
    invitedByName: string,
    roleName: string,
  ): Promise<{ sent: boolean; error?: string }> {
    const transport = await this.createTransporter();

    if (transport) {
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

        this.logger.log(`Invitation email sent to ${to}`);
        return { sent: true };
      } catch (err: any) {
        this.logger.error(`Failed to send invitation via SMTP to ${to}: ${err}`);
        return { sent: false, error: err.message || 'SMTP delivery failed' };
      }
    }

    // Fallback: send via external API (requires active license)
    // Try to find a valid license key: first any active license in DB, then site_settings
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
      `SMTP not configured, using external API fallback (licenseKey ${licenseKey ? 'present' : 'MISSING'})`,
    );
    return this.sendViaExternalApiWithError('/api/email/invite', {
      email: to,
      inviterName: invitedByName,
      instanceUrl: inviteUrl,
      ...(licenseKey ? { licenseKey } : {}),
    });
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

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const smtp = await this.siteSettings.getSmtpConfig();
    if (!smtp) {
      return { ok: false, message: 'SMTP not configured' };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: {
          user: smtp.user,
          pass: smtp.pass,
        },
      });

      await transporter.verify();
      return { ok: true, message: 'SMTP connection successful' };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Connection failed' };
    }
  }
}
