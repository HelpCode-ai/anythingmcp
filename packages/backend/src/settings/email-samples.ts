import type { EmailBrandContext } from './email-layout';
import type { TrustStats } from '../public-stats/trust-stats.format';
import {
  RenderedEmail,
  type RetentionOffer,
  activationReminderEmail,
  appApprovedEmail,
  planCapsAppliedEmail,
  cardTrialOfferEmail,
  connectorAuthEmail,
  existingAccountEmail,
  invitationEmail,
  licenseKeyEmail,
  onboardingReminderEmail,
  passwordResetEmail,
  trialLifecycleEmail,
  trialWinbackEmail,
  trialBlockedCallsEmail,
  trialEndedBusinessEmail,
  verificationEmail,
} from './email-templates';

/**
 * Every email and variant with sample data, for the preview script and the
 * template tests. Names are parameters so the tests can feed hostile values.
 */

export const SAMPLE_CLOUD_URL = 'https://cloud.anythingmcp.com';
export const SAMPLE_MARKETING_URL = 'https://anythingmcp.com';
/** When the sample trials ended: the first win-back goes out a day later. */
const SAMPLE_TRIAL_ENDED_AT = new Date('2026-10-07T09:30:00Z');
/** The sample win-back codes, as the licence site mints them, valid 14 days. */
const SAMPLE_CODES_EXPIRE_AT = new Date('2026-10-22T09:30:00Z');
const SAMPLE_LOCKED: RetentionOffer = {
  kind: 'locked',
  monthlyCode: 'KEEP-7F3K9Q',
  yearlyCode: 'KEEP-Y4M8RT',
  codesExpireAt: SAMPLE_CODES_EXPIRE_AT,
};
const SAMPLE_PERSONAL: RetentionOffer = { kind: 'personal', code: 'KEEP-P6W2XN', codesExpireAt: SAMPLE_CODES_EXPIRE_AT };
/** When the sample trial of the card-trial offer ends. */
const SAMPLE_TRIAL_ENDS_AT = new Date('2026-10-18T09:30:00Z');

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
    id: 'connector-auth',
    render: (ctx, n) =>
      connectorAuthEmail(
        {
          name: n.name,
          connectorName: n.other,
          message:
            "Google revoked the sign-in 7 days after it was granted. This happens when the OAuth app in your Google Cloud project is in 'Testing'. Publish it ('In production') under APIs & Services → OAuth consent screen, then click Authorize with Provider again.",
          connectorUrl: `${SAMPLE_CLOUD_URL}/connectors/sample-connector`,
        },
        ctx,
      ),
  },
  {
    id: 'app-approved-etsy',
    render: (ctx, n) =>
      appApprovedEmail(
        {
          name: n.name,
          providerName: 'Etsy',
          connectorUrl: `${SAMPLE_CLOUD_URL}/connectors/sample-connector`,
          prompt: 'Show my last 10 Etsy orders',
          promptUrl: 'https://claude.ai/new?q=Show%20my%20last%2010%20Etsy%20orders',
        },
        ctx,
      ),
  },
  {
    id: 'plan-caps-applied',
    render: (ctx, n) =>
      planCapsAppliedEmail(
        {
          name: n.name,
          workspaceName: n.other,
          planName: 'Starter',
          paused: { connectors: ['Etsy', n.other], mcpServers: ['Support desk'], fileSearch: [] },
          kept: { connectors: 5, mcpServers: 3 },
          connectorsUrl: `${SAMPLE_CLOUD_URL}/connectors`,
          planUrl: `${SAMPLE_CLOUD_URL}/settings/license`,
        },
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
    id: 'onboarding-day1-quick',
    render: (ctx, n) =>
      onboardingReminderEmail(
        {
          name: n.name,
          dayNumber: 1,
          cloudUrl: SAMPLE_CLOUD_URL,
          quickSetups: [
            { label: 'Telegram bot', url: 'https://claude.ai/new?q=Connect%20my%20Telegram%20bot%20to%20AnythingMCP' },
            { label: 'Odoo', url: 'https://claude.ai/new?q=Connect%20my%20Odoo%20to%20AnythingMCP' },
            { label: 'Shopify store', url: 'https://claude.ai/new?q=Connect%20my%20Shopify%20store%20to%20AnythingMCP' },
          ],
        },
        unsub(ctx),
      ),
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
    id: 'winback-locked-first',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'offer', offer: SAMPLE_LOCKED, stage: 'first', trialEndedAt: SAMPLE_TRIAL_ENDED_AT, successfulCalls: 148 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-locked-final',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'offer', offer: SAMPLE_LOCKED, stage: 'final', trialEndedAt: SAMPLE_TRIAL_ENDED_AT, successfulCalls: 0 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-personal-first',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'offer', offer: SAMPLE_PERSONAL, stage: 'first', trialEndedAt: SAMPLE_TRIAL_ENDED_AT, successfulCalls: 37 },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    id: 'winback-personal-final',
    render: (ctx, n) =>
      trialWinbackEmail(
        {
          name: n.name,
          offer: { kind: 'offer', offer: SAMPLE_PERSONAL, stage: 'final', trialEndedAt: SAMPLE_TRIAL_ENDED_AT, successfulCalls: 5 },
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
        {
          name: n.name,
          offer: { kind: 'help', trialEndedAt: SAMPLE_TRIAL_ENDED_AT },
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    // The AI kept calling a tool after the trial ended. `other` stands in for
    // the OAuth client's self-chosen name, so the escaping is exercised.
    id: 'blocked-calls',
    render: (ctx, n) =>
      trialBlockedCallsEmail(
        {
          name: n.name,
          clientName: n.other || null,
          appName: 'Etsy',
          attempts: 6,
          offer: SAMPLE_LOCKED,
          trialEndedAt: SAMPLE_TRIAL_ENDED_AT,
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    // The same, for a workspace that never made a successful call.
    id: 'blocked-calls-never-used',
    render: (ctx, n) =>
      trialBlockedCallsEmail(
        {
          name: n.name,
          clientName: n.other || null,
          appName: 'Etsy',
          attempts: 3,
          neverUsed: true,
          offer: SAMPLE_PERSONAL,
          trialEndedAt: SAMPLE_TRIAL_ENDED_AT,
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    // The expiry day of a business workspace: a plain email from Matteo.
    id: 'trial-ended-business',
    render: (ctx, n) =>
      trialEndedBusinessEmail(
        {
          name: n.name,
          recap: { connectors: 3, successfulCalls: 412, topConnector: n.other || 'Odoo' },
          extendUrl: `${SAMPLE_CLOUD_URL}/api/license/extend?token=sample-org.1760000000.sample-signature`,
          offer: SAMPLE_LOCKED,
          cloudUrl: SAMPLE_CLOUD_URL,
          marketingUrl: SAMPLE_MARKETING_URL,
        },
        unsub(ctx),
      ),
  },
  {
    // A day after sign-up the sample workspace made its first successful call.
    id: 'card-trial-offer',
    render: (ctx, n) =>
      cardTrialOfferEmail(
        {
          name: n.name,
          connectorName: n.other,
          nextSteps: [
            { name: 'shopify_get_product', text: 'Get one product with its variants and stock.' },
            { name: 'shopify_search_customers', text: 'Search customers by name, email or tag.' },
            { name: n.other, text: n.name },
          ],
          trialEndsAt: SAMPLE_TRIAL_ENDS_AT,
          ctaUrl: `${SAMPLE_CLOUD_URL}/start-trial?source=first_success_email`,
          cardTrial: true,
        },
        unsub(ctx),
      ),
  },
  {
    // Under 48 hours of trial left: no card trial, the plans instead. Connector gone.
    id: 'card-trial-offer-plans',
    render: (ctx, n) =>
      cardTrialOfferEmail(
        {
          name: n.name,
          connectorName: null,
          nextSteps: [],
          trialEndsAt: SAMPLE_TRIAL_ENDS_AT,
          ctaUrl: `${SAMPLE_CLOUD_URL}/settings/license?source=first_success_email`,
          cardTrial: false,
        },
        unsub(ctx),
      ),
  },
];

/** Ids of the samples that must carry an unsubscribe line. */
export const MARKETING_SAMPLE_IDS = new Set([
  'onboarding-day1',
  'onboarding-day1-quick',
  'onboarding-day2',
  'onboarding-client-connected',
  'activation-connect-client',
  'activation-test-connector',
  'winback-locked-first',
  'winback-locked-final',
  'winback-personal-first',
  'winback-personal-final',
  'winback-help',
  'blocked-calls',
  'blocked-calls-never-used',
  'trial-ended-business',
  'card-trial-offer',
  'card-trial-offer-plans',
]);

/** Samples that carry a price offer: the "no price talk" check does not apply. */
export const OFFER_SAMPLE_IDS = new Set([
  'winback-locked-first',
  'winback-locked-final',
  'winback-personal-first',
  'winback-personal-final',
  'blocked-calls',
  'blocked-calls-never-used',
  'trial-ended-business',
]);

/** Samples written as a personal plain email, without the shared layout. */
export const PLAIN_SAMPLE_IDS = new Set(['trial-ended-business']);
