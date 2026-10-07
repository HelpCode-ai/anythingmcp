import * as nodemailer from 'nodemailer';
import { EmailService } from './email.service';
import { verifyUnsubscribe } from './unsubscribe-token';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

/**
 * What EmailService hands to the SMTP transport: both parts, the shared
 * layout with the live trust numbers, and List-Unsubscribe only on marketing.
 */
describe('EmailService', () => {
  const sendMail = jest.fn().mockResolvedValue({});
  const ENV = { ...process.env };

  function make(opts: { cloud?: boolean; stats?: any; user?: { id: string } | null } = {}) {
    const siteSettings = { getSmtpConfig: jest.fn().mockResolvedValue(null), get: jest.fn() };
    const orgSettings = { getJson: jest.fn().mockResolvedValue(null) };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(opts.user === undefined ? { id: 'user-1' } : opts.user) },
      license: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const cloud = opts.cloud ?? true;
    const deployment = { isCloud: () => cloud, isSelfHosted: () => !cloud };
    const stats = opts.stats ?? {
      githubStars: 1234,
      dockerPulls: 32_999,
      workspaces: 3_871,
      toolCalls30d: 651_000,
      updatedAt: '2026-10-07T10:00:00.000Z',
    };
    const trustStats = { get: jest.fn().mockResolvedValue(stats), peek: jest.fn().mockReturnValue(stats) };
    const service = new EmailService(
      siteSettings as any,
      orgSettings as any,
      prisma as any,
      deployment as any,
      trustStats as any,
    );
    return { service, prisma, trustStats };
  }

  beforeEach(() => {
    sendMail.mockClear();
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'mailer@anythingmcp.com';
    process.env.JWT_SECRET = 'test-secret-for-unsubscribe-links';
    process.env.CLOUD_PUBLIC_URL = 'https://cloud.anythingmcp.com';
  });

  afterAll(() => {
    process.env = ENV;
  });

  const sent = () => sendMail.mock.calls[0][0];

  it('sends transactional email as HTML and text, without List-Unsubscribe', async () => {
    const { service } = make();
    await expect(service.sendVerificationEmail('a@b.com', '123456', 'https://cloud.anythingmcp.com/v?t=1')).resolves.toBe(true);
    const mail = sent();
    expect(mail.subject).toBe('123456 is your AnythingMCP verification code');
    expect(mail.html).toContain('123 456');
    expect(mail.text).toContain('123456');
    expect(mail.headers).toBeUndefined();
    expect(mail.html).not.toContain('Unsubscribe');
    // Live numbers, rounded down.
    expect(mail.html).toContain('1,200+');
    expect(mail.html).toContain('32,000+');
    expect(mail.html).toContain('650,000+');
  });

  it('escapes the inviter and role in invitations', async () => {
    const { service } = make();
    await service.sendInvitationEmail('a@b.com', 'https://cloud.anythingmcp.com/i', '<b onmouseover=x>Eve</b>', '<i>Admin</i>');
    const mail = sent();
    expect(mail.html).toContain('&lt;b onmouseover=x&gt;Eve&lt;/b&gt;');
    expect(mail.html).toContain('&lt;i&gt;Admin&lt;/i&gt;');
    expect(mail.html).not.toContain('<b onmouseover');
  });

  it('gives marketing email a signed one-click unsubscribe link and header', async () => {
    const { service } = make();
    await service.sendOnboardingReminderEmail('a@b.com', 'Ada', 1);
    const mail = sent();
    const header: string = mail.headers['List-Unsubscribe'];
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = new URL(header.slice(1, -1));
    expect(url.origin).toBe('https://cloud.anythingmcp.com');
    expect(url.pathname).toBe('/api/public/unsubscribe');
    expect(url.searchParams.get('u')).toBe('user-1');
    expect(verifyUnsubscribe('user-1', url.searchParams.get('t'), process.env.JWT_SECRET!)).toBe(true);
    // The footer link and the text part lead to the same place.
    expect(mail.html).toContain(url.toString().replace(/&/g, '&amp;'));
    expect(mail.text).toContain(url.toString());
  });

  it('falls back to the account settings when no account matches', async () => {
    const { service } = make({ user: null });
    await service.sendTrialWinbackEmail('a@b.com', 'Ada', { kind: 'help' });
    const mail = sent();
    expect(mail.headers['List-Unsubscribe']).toBe('<https://cloud.anythingmcp.com/settings#email-preferences>');
    expect(mail.headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('sends trial lifecycle notices with the user’s usage and no unsubscribe', async () => {
    const { service } = make();
    await service.sendTrialLifecycleEmail('a@b.com', 'Ada', 'warn3', { connectors: 2, successfulCalls: 41, daysLeft: 3 });
    const mail = sent();
    expect(mail.subject).toBe('Your AnythingMCP trial ends in 3 days');
    expect(mail.html).toContain('41');
    expect(mail.text).toContain('2 connectors set up, 41 successful tool calls');
    expect(mail.headers).toBeUndefined();
  });

  it('makes no Cloud-only claims on a self-hosted instance', async () => {
    const { service } = make({ cloud: false });
    await service.sendPasswordResetEmail('a@b.com', 'https://mcp.example.com/reset?t=1');
    const mail = sent();
    expect(mail.html).not.toMatch(/Frankfurt|DPA|Claude Directory|AI tool calls/);
    expect(mail.html).toContain('Open source');
  });

  it('still sends when the trust numbers are unavailable', async () => {
    const { service, trustStats } = make();
    trustStats.get.mockRejectedValue(new Error('down'));
    trustStats.peek.mockReturnValue({ githubStars: null, dockerPulls: null, workspaces: null, toolCalls30d: null, updatedAt: null });
    await expect(service.sendExistingAccountEmail('a@b.com', 'https://cloud.anythingmcp.com/login', 'https://cloud.anythingmcp.com/forgot-password')).resolves.toBe(true);
    expect(sent().html).not.toContain('stars on GitHub');
  });
});
