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
        from: smtp.from || `AnythingToMCP <${smtp.user}>`,
        to,
        subject: 'Password Reset — AnythingToMCP',
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #6366f1;">Password Reset</h2>
            <p>You requested a password reset for your AnythingToMCP account.</p>
            <p>Click the button below to set a new password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 16px 0;">
              Reset Password
            </a>
            <p style="color: #737373; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
            <p style="color: #a3a3a3; font-size: 12px;">AnythingToMCP</p>
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
