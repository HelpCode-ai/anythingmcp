import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { SiteSettingsService } from './site-settings.service';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'Anything MCP <noreply@anythingmcp.com>';

const EMAIL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" width="36" height="36" fill="none" style="vertical-align: middle; margin-right: 8px;">
  <line x1="26" y1="26" x2="26" y2="9" stroke="#2563EB" stroke-width="1.5" stroke-linecap="round" style="opacity: 0.55" />
  <line x1="26" y1="26" x2="10" y2="40" stroke="#2563EB" stroke-width="1.5" stroke-linecap="round" style="opacity: 0.55" />
  <line x1="26" y1="26" x2="42" y2="40" stroke="#2563EB" stroke-width="1.5" stroke-linecap="round" style="opacity: 0.55" />
  <circle cx="26" cy="9" r="5" fill="#2563EB" style="opacity: 0.65" />
  <circle cx="10" cy="40" r="5" fill="#2563EB" style="opacity: 0.65" />
  <circle cx="42" cy="40" r="5" fill="#2563EB" style="opacity: 0.65" />
  <circle cx="26" cy="26" r="10" fill="#2563EB" />
  <circle cx="26" cy="26" r="5.5" fill="#FFFFFF" />
</svg>`;

const EMAIL_HEADER = `<div style="margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e5e5;">
  ${EMAIL_LOGO_SVG}<span style="font-size: 20px; font-weight: bold; vertical-align: middle;"><span style="color: #111827;">Anything</span><span style="color: #2563eb;">MCP</span></span>
</div>`;

const EMAIL_FOOTER = `<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0;" />
<p style="color: #737373; font-size: 14px;">
  helpcode.ai GmbH &mdash; <a href="https://anythingmcp.com" style="color: #2563eb;">anythingmcp.com</a>
</p>`;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;

  constructor(private readonly siteSettings: SiteSettingsService) {
    if (RESEND_API_KEY) {
      this.resend = new Resend(RESEND_API_KEY);
      this.logger.log('Resend email provider configured');
    }
  }

  // ── Core send method (Resend → SMTP fallback) ─────────────────────────────

  private async send(
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<boolean> {
    // Try Resend first
    if (this.resend) {
      try {
        const { error } = await this.resend.emails.send({
          from: RESEND_FROM,
          to: [to],
          subject,
          html,
          text,
        });
        if (error) throw new Error(error.message);
        this.logger.log(`Email sent via Resend to ${to}: ${subject}`);
        return true;
      } catch (err: any) {
        this.logger.error(`Resend failed for ${to}: ${err.message}`);
      }
    }

    // Fallback to SMTP
    const transport = await this.createTransporter();
    if (transport) {
      try {
        await transport.transporter.sendMail({
          from: transport.from,
          to,
          subject,
          html,
          text,
        });
        this.logger.log(`Email sent via SMTP to ${to}: ${subject}`);
        return true;
      } catch (err: any) {
        this.logger.error(`SMTP failed for ${to}: ${err.message}`);
      }
    }

    this.logger.warn(`No email provider available — could not send to ${to}`);
    return false;
  }

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
      from: smtp.from || `Anything MCP <${smtp.user}>`,
    };
  }

  // ── Password Reset ────────────────────────────────────────────────────────

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
  ): Promise<boolean> {
    return this.send(
      to,
      'Password Reset — Anything MCP',
      `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        ${EMAIL_HEADER}
        <h1 style="color: #2563eb;">Password Reset</h1>
        <p>You requested a password reset for your <span style="color: #111827;">Anything</span><span style="color: #2563eb;">MCP</span> account.</p>
        <p>Click the button below to set a new password. This link expires in 1 hour.</p>
        <div style="margin: 24px 0;">
          <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
            Reset Password
          </a>
        </div>
        <p style="color: #737373; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
        ${EMAIL_FOOTER}
      </div>`,
      `Password Reset\n\nYou requested a password reset. Click here to set a new password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
    );
  }

  // ── Invitation Email ──────────────────────────────────────────────────────

  async sendInvitationEmail(
    to: string,
    inviteUrl: string,
    invitedByName: string,
    roleName: string,
  ): Promise<boolean> {
    return this.send(
      to,
      `${invitedByName} invited you to Anything MCP`,
      `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        ${EMAIL_HEADER}
        <h1 style="color: #2563eb;">You've been invited!</h1>
        <p><strong>${invitedByName}</strong> has invited you to join their <span style="color: #111827;">Anything</span><span style="color: #2563eb;">MCP</span> instance as <strong>${roleName}</strong>.</p>
        <p>Click the button below to create your account. This invitation expires in 48 hours.</p>
        <div style="margin: 24px 0;">
          <a href="${inviteUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
            Accept Invitation
          </a>
        </div>
        <p style="color: #737373; font-size: 14px;">If you weren't expecting this invite, you can safely ignore this email.</p>
        ${EMAIL_FOOTER}
      </div>`,
      `You're Invited!\n\n${invitedByName} has invited you to join Anything MCP as ${roleName}.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 48 hours.`,
    );
  }

  // ── Welcome Email ─────────────────────────────────────────────────────────

  async sendWelcomeEmail(
    to: string,
    name: string,
    licenseKey: string,
  ): Promise<boolean> {
    return this.send(
      to,
      'Welcome to Anything MCP — Your License Key',
      `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        ${EMAIL_HEADER}
        <h1 style="color: #2563eb;">Welcome!</h1>
        <p>Hi ${name},</p>
        <p>Thank you for registering. Here is your license key:</p>
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 24px 0; text-align: center;">
          <code style="font-size: 18px; font-weight: bold; letter-spacing: 2px;">${licenseKey}</code>
        </div>
        <p>To get started:</p>
        <ol>
          <li>Copy your license key above</li>
          <li>Enter it in your <span style="color: #111827;">Anything</span><span style="color: #2563eb;">MCP</span> instance settings</li>
          <li>Follow our <a href="https://anythingmcp.com/docs/getting-started" style="color: #2563eb;">Getting Started Guide</a></li>
        </ol>
        ${EMAIL_FOOTER}
      </div>`,
      `Welcome to Anything MCP!\n\nHi ${name},\n\nYour license key is: ${licenseKey}\n\nKeep this key safe — you'll need it to activate your Anything MCP instance.`,
    );
  }

  // ── Verification Email ────────────────────────────────────────────────────

  async sendVerificationEmail(
    to: string,
    code: string,
    verifyUrl: string,
  ): Promise<boolean> {
    if (!this.resend && !(await this.siteSettings.getSmtpConfig())) {
      this.logger.warn(
        `No email provider configured — verification code for ${to}: ${code}`,
      );
    }

    return this.send(
      to,
      'Verify Your Email — Anything MCP',
      `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        ${EMAIL_HEADER}
        <h1 style="color: #2563eb;">Verify Your Email</h1>
        <p>Your verification code is:</p>
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 24px 0; text-align: center;">
          <code style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${code}</code>
        </div>
        <p>This code expires in 15 minutes.</p>
        <p>Or click the button below to verify:</p>
        <div style="margin: 24px 0;">
          <a href="${verifyUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
            Verify Email
          </a>
        </div>
        <p style="color: #737373; font-size: 14px;">If you didn't create this account, you can safely ignore this email.</p>
        ${EMAIL_FOOTER}
      </div>`,
      `Verify Your Email\n\nYour verification code: ${code}\n\nOr verify here: ${verifyUrl}\n\nThis code expires in 15 minutes.`,
    );
  }

  // ── SMTP Test ─────────────────────────────────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (this.resend) {
      return { ok: true, message: 'Resend configured (RESEND_API_KEY set)' };
    }

    const smtp = await this.siteSettings.getSmtpConfig();
    if (!smtp) {
      return { ok: false, message: 'No email provider configured (set RESEND_API_KEY or configure SMTP)' };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
      });
      await transporter.verify();
      return { ok: true, message: 'SMTP connection successful' };
    } catch (err: any) {
      return { ok: false, message: err.message || 'Connection failed' };
    }
  }
}
