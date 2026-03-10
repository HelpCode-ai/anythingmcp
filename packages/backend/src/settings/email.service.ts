import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import { SiteSettingsService } from './site-settings.service';

const LICENSE_API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://anythingmcp.com'
    : 'http://localhost:3100';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiBase = LICENSE_API_URL;

  constructor(private readonly siteSettings: SiteSettingsService) {}

  // ── Password Reset (SMTP only — no external fallback for security) ────────

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
  ): Promise<boolean> {
    const smtp = await this.siteSettings.getSmtpConfig();
    if (!smtp) {
      this.logger.warn(
        'SMTP not configured for password reset, no fallback available',
      );
      return false;
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
      this.logger.error(`Failed to send email to ${to}: ${err}`);
      return false;
    }
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
  ): Promise<boolean> {
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
        return true;
      } catch (err) {
        this.logger.error(`Failed to send invitation via SMTP to ${to}: ${err}`);
        return false;
      }
    }

    // Fallback: send via external API (requires active license)
    const licenseKey = await this.siteSettings.get('license_key');
    this.logger.log(
      `SMTP not configured, using external API fallback (licenseKey ${licenseKey ? 'present' : 'MISSING'})`,
    );
    return this.sendViaExternalApi('/api/email/invite', {
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
      // Log verification code to console so developers can verify manually
      this.logger.warn(
        `SMTP not configured — verification code for ${to}: ${code}`,
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
