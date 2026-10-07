import type { EmailBrandContext } from './email-layout';
import type { TrustStats } from '../public-stats/trust-stats.format';
import {
  RenderedEmail,
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

/**
 * Every email and variant with sample data, for the preview script and the
 * template tests. Names are parameters so the tests can feed hostile values.
 */

export const SAMPLE_CLOUD_URL = 'https://cloud.anythingmcp.com';
export const SAMPLE_MARKETING_URL = 'https://anythingmcp.com';

/** Placeholder numbers for previews only; real emails use TrustStatsService. */
export const SAMPLE_TRUST_STATS: TrustStats = {
  githubStars: 984,
  dockerPulls: 32_456,
  workspaces: 3_871,
  toolCalls30d: 654_321,
  updatedAt: null,
};

export interface EmailSample {
  /** File-name friendly id, e.g. "trial-warn3". */
  id: string;
  render: (ctx: EmailBrandContext, names: { name: string; other: string }) => RenderedEmail;
}

const unsub = (ctx: EmailBrandContext) => ({
  ...ctx,
  unsubscribeUrl: `${SAMPLE_CLOUD_URL}/api/public/unsubscribe?u=sample-user&t=sample-token`,
});

export const EMAIL_SAMPLES: EmailSample[] = [
  {
    id: 'verification',
    render: (ctx) =>
      verificationEmail({ code: '482913', verifyUrl: `${SAMPLE_CLOUD_URL}/verify-email?token=sample` }, ctx),
  },
  {
    id: 'password-reset',
    render: (ctx) => passwordResetEmail({ resetUrl: `${SAMPLE_CLOUD_URL}/reset-password?token=sample` }, ctx),
  },
  {
    id: 'invitation',
    render: (ctx, n) =>
      invitationEmail(
        { inviteUrl: `${SAMPLE_CLOUD_URL}/accept-invite?token=sample`, invitedByName: n.name, roleName: n.other },
        ctx,
      ),
  },
  {
    id: 'license-key',
    render: (ctx, n) => licenseKeyEmail({ name: n.name, licenseKey: 'AMCP-7Q2K-9XWD-4MRT-HB3N' }, ctx),
  },
  {
    id: 'existing-account',
    render: (ctx) =>
      existingAccountEmail({ loginUrl: `${SAMPLE_CLOUD_URL}/login`, resetUrl: `${SAMPLE_CLOUD_URL}/forgot-password` }, ctx),
  },
  {
    id: 'onboarding-day1',
    render: (ctx, n) => onboardingReminderEmail({ name: n.name, dayNumber: 1, cloudUrl: SAMPLE_CLOUD_URL }, unsub(ctx)),
  },
  {
    id: 'onboarding-day2',
    render: (ctx, n) => onboardingReminderEmail({ name: n.name, dayNumber: 2, cloudUrl: SAMPLE_CLOUD_URL }, unsub(ctx)),
  },
  {
    id: 'onboarding-client-connected',
    render: (ctx, n) =>
      onboardingReminderEmail({ name: n.name, dayNumber: 1, aiClient: n.other, cloudUrl: SAMPLE_CLOUD_URL }, unsub(ctx)),
  },
  ...(['warn3', 'warn1', 'expired'] as const).map((stage) => ({
    id: `trial-${stage}`,
    render: (ctx: EmailBrandContext, n: { name: string }) =>
      trialLifecycleEmail(
        {
          name: n.name,
          stage,
          recap: { connectors: 3, successfulCalls: 148, daysLeft: stage === 'warn3' ? 3 : stage === 'warn1' ? 1 : 0 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        ctx,
      ),
  })),
  {
    id: 'trial-warn3-no-usage',
    render: (ctx, n) =>
      trialLifecycleEmail(
        {
          name: n.name,
          stage: 'warn3',
          recap: { connectors: 0, successfulCalls: 0, daysLeft: 3 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        ctx,
      ),
  },
  {
    id: 'activation-connect-client',
    render: (ctx, n) =>
      activationReminderEmail(
        { name: n.name, connectorUrl: `${SAMPLE_CLOUD_URL}/mcp-server/srv_123`, variant: 'connect-client' },
        unsub(ctx),
      ),
  },
  {
    id: 'activation-test-connector',
    render: (ctx, n) =>
      activationReminderEmail(
        { name: n.name, connectorUrl: `${SAMPLE_CLOUD_URL}/connectors/con_123`, variant: 'test-connector' },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-discount-week',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'discount', percentOff: 30, promoCode: 'START30', endedAgo: 'week', successfulCalls: 148 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-discount-month',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'discount', percentOff: 50, promoCode: 'WINBACK50', endedAgo: 'month', successfulCalls: 0 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-help',
    render: (ctx, n) =>
      trialWinbackEmail(
        { name: n.name, offer: { kind: 'help' }, cloudUrl: SAMPLE_CLOUD_URL, marketingUrl: SAMPLE_MARKETING_URL },
        unsub(ctx),
      ),
  },
];

/** Ids of the samples that must carry an unsubscribe line. */
export const MARKETING_SAMPLE_IDS = new Set([
  'onboarding-day1',
  'onboarding-day2',
  'onboarding-client-connected',
  'activation-connect-client',
  'activation-test-connector',
  'winback-discount-week',
  'winback-discount-month',
  'winback-help',
]);
