import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SiteSettingsService } from './site-settings.service';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly siteSettings: SiteSettingsService) {}

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
  ): Promise<boolean> {
    const smtp = await this.siteSettings.getSmtpConfig();
    if (!smtp) {
      this.logger.warn(
        'Cannot send password reset email: SMTP not configured',
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
            <h2 style="color: #6366f1;">Password Reset</h2>
            <p>You requested a password reset for your AnythingMCP account.</p>
            <p>Click the button below to set a new password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
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
    if (!transport) {
      this.logger.warn('Cannot send invitation email: SMTP not configured');
      return false;
    }

    try {
      await transport.transporter.sendMail({
        from: transport.from,
        to,
        subject: 'You\'ve been invited to AnythingMCP',
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #6366f1;">You're Invited!</h2>
            <p><strong>${invitedByName}</strong> has invited you to join the AnythingMCP workspace as <strong>${roleName}</strong>.</p>
            <p>Click the button below to create your account. This invitation expires in 48 hours.</p>
            <a href="${inviteUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
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
      this.logger.error(`Failed to send invitation to ${to}: ${err}`);
      return false;
    }
  }

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
