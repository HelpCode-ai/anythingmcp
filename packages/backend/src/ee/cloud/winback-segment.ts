import { createHash } from 'crypto';
import { isConsumerEmail } from '../../common/consumer-email-domains';
import { getAdapter } from '../../adapters/catalog';

/**
 * Who a Cloud workspace is, for the emails that try to win it back after its
 * trial, and whether it is in the control group that gets none of them.
 *
 * One function for every pass of the onboarding cron, so the segments cannot
 * drift between emails:
 *
 * - `unused`: never made a successful tool call. Gets the how-to, never an
 *   offer, and is never held out.
 * - `business`: an active admin on a company address (not a consumer mailbox
 *   like gmail.com), or a business connector (BUSINESS_CONNECTORS).
 * - `telegram`: used, consumer addresses only, and every catalog connector is
 *   a Telegram bot (TELEGRAM_SLUGS).
 * - `consumer`: used, consumer addresses only, no business connector. Vinted
 *   sellers stay here: they sell their own things.
 *
 * Cloud only: CloudModule, which provides the cron, is imported only when
 * DEPLOYMENT_MODE=cloud.
 */
export type WinbackSegment = 'unused' | 'business' | 'telegram' | 'consumer';

/**
 * Connectors that mark a workspace as a business, by catalog category: an
 * Etsy or Shopify seller writing from a Gmail address is a small business,
 * not a private user. Vinted is the exception: its sellers are private people
 * selling their own things. Custom connectors (not from the catalog) say
 * nothing either way.
 */
export const BUSINESS_CONNECTORS = {
  categories: new Set([
    'e-commerce',
    'crm',
    'accounting',
    'erp',
    'payments',
    'logistics',
    'finance',
    'hr',
    'support',
    'itsm',
    'wholesale',
    'advertising',
    'marketing-automation',
    'field-service',
    'construction',
    'dms',
    'time-tracking',
    'e-signature',
    'banking',
  ]),
  privateSlugs: new Set(['vinted']),
};

/** The catalog's Telegram bot adapters (intl/telegram-bot.json). */
export const TELEGRAM_SLUGS = new Set(['telegram-bot']);

/** The catalog adapter a connector was installed from, from its config; null for custom ones. */
export function connectorAdapterSlug(config: unknown): string | null {
  const slug = (config as { adapterSlug?: unknown } | null)?.adapterSlug;
  return typeof slug === 'string' && slug && getAdapter(slug) ? slug : null;
}

export function isBusinessConnector(config: unknown): boolean {
  const slug = connectorAdapterSlug(config);
  if (!slug || BUSINESS_CONNECTORS.privateSlugs.has(slug)) return false;
  const category = getAdapter(slug)?.category;
  return !!category && BUSINESS_CONNECTORS.categories.has(category);
}

export function winbackSegment(input: {
  /** The active admins' addresses. */
  adminEmails: string[];
  /** The workspace's connectors' `config` (adapterSlug inside). */
  connectorConfigs: unknown[];
  /** Successful tool calls the workspace ever made. */
  successfulCalls: number;
}): WinbackSegment {
  if (input.successfulCalls <= 0) return 'unused';
  if (input.adminEmails.some((e) => !isConsumerEmail(e))) return 'business';
  if (input.connectorConfigs.some((c) => isBusinessConnector(c))) return 'business';
  const slugs = input.connectorConfigs.map(connectorAdapterSlug).filter((s): s is string => !!s);
  if (slugs.length > 0 && slugs.every((s) => TELEGRAM_SLUGS.has(s))) return 'telegram';
  return 'consumer';
}

/**
 * The control group: workspaces that get no win-back and no blocked-call
 * offer email, so each offer's effect can be measured against them. They still
 * get the trial lifecycle emails, which are account notices.
 *
 * Decided by the first byte of sha256('winback-holdout:' + id), so a re-run
 * never moves a workspace, and independent of the first-month test's hash
 * (winbackTestArm). About 10% of business workspaces (byte < 26), which are
 * worth the most each, and 20% of consumer and Telegram ones (byte < 51),
 * which are many, so their effect shows sooner. `unused` is never held out:
 * it gets no offer anyway.
 */
export const HOLDOUT_BYTE_BELOW: Record<Exclude<WinbackSegment, 'unused'>, number> = {
  business: 26,
  consumer: 51,
  telegram: 51,
};

export function holdoutByte(organizationId: string): number {
  return createHash('sha256').update(`winback-holdout:${organizationId}`).digest()[0];
}

export function inWinbackHoldout(organizationId: string, segment: WinbackSegment): boolean {
  if (segment === 'unused') return false;
  return holdoutByte(organizationId) < HOLDOUT_BYTE_BELOW[segment];
}

/**
 * OrgSettings keys. `winback_holdout` is the decision, stored the first time a
 * workspace is due an offer and kept from then on, even if its segment
 * changes: `<segment>:control` (held out) or `<segment>:treatment`.
 * `winback_offer` is the last offer email sent, `<segment>:<offer>:<stage>`.
 * Together they make the per-segment, per-offer report a plain query.
 */
export const WINBACK_HOLDOUT_KEY = 'winback_holdout';
export const WINBACK_OFFER_KEY = 'winback_offer';

export function holdoutValue(segment: WinbackSegment, held: boolean): string {
  return `${segment}:${held ? 'control' : 'treatment'}`;
}

/** Whether a stored `winback_holdout` value means the control group. */
export function isHoldoutValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.endsWith(':control');
}

export function offerValue(segment: WinbackSegment, offer: string, stage: string): string {
  return `${segment}:${offer}:${stage}`;
}
