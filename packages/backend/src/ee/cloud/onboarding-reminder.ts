// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { createHash } from 'crypto';
import { ProductEvents } from '../../audit/product-event.service';

/**
 * Who gets which onboarding reminder (onboarding-cron.service.ts).
 *
 * Reminder 1 (about an hour after sign-up) is an A/B test with a control
 * group, decided per user:
 *
 * - `holdout`: about 10% get no reminder 1 at all, so its effect can be
 *   measured against nothing;
 * - `A`: today's email (the generic how-to, or the AI-client one);
 * - `B`: the generic how-to replaced by three one-click Claude chats for
 *   setups that need no app approval (QUICK_SETUPS), plus the dashboard.
 *
 * The arm comes from sha256('onboarding-reminder:' + userId): the first byte
 * below HOLDOUT_BYTE_BELOW is the holdout, then the second byte splits the
 * rest in halves. A re-run never moves a user, and the hash is independent of
 * the win-back one (winback-segment.ts). The cron stores the arm with every
 * reminder it sends or withholds (product events `onboarding_reminder_sent`
 * and `onboarding_reminder_holdout`, metadata.arm), so "a connector within 7
 * days of sign-up" can be read per arm with one query.
 *
 * Reminder 2 (three days after sign-up) only goes to users who showed intent
 * (showedIntent). Of the users who got both reminders, 1.6% ever had a
 * connector, and the second one to all of them was about 4,000 emails a week
 * that hurt the sending reputation.
 *
 * Cloud only: CloudModule, which provides the cron, is imported only when
 * DEPLOYMENT_MODE=cloud.
 */
export type ReminderArm = 'A' | 'B' | 'holdout';

/** First hash byte below this: holdout (26/256 = 10.2%). */
export const HOLDOUT_BYTE_BELOW = 26;

export function reminderArm(userId: string): ReminderArm {
  const digest = createHash('sha256').update(`onboarding-reminder:${userId}`).digest();
  if (digest[0] < HOLDOUT_BYTE_BELOW) return 'holdout';
  return digest[1] < 128 ? 'A' : 'B';
}

/**
 * Variant B's one-click requests: catalog connectors (intl/telegram-bot,
 * intl/odoo, intl/shopify) set up with a token or an API key the user creates
 * themselves, with no app review by the provider (unlike Etsy).
 */
export const QUICK_SETUPS: ReadonlyArray<{ adapterSlug: string; label: string; request: string }> = [
  { adapterSlug: 'telegram-bot', label: 'Telegram bot', request: 'Connect my Telegram bot to AnythingMCP' },
  { adapterSlug: 'odoo', label: 'Odoo', request: 'Connect my Odoo to AnythingMCP' },
  { adapterSlug: 'shopify', label: 'Shopify store', request: 'Connect my Shopify store to AnythingMCP' },
];

/** A new Claude chat with the request typed in. */
export function claudeChatUrl(request: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(request)}`;
}

/**
 * Events that show a user wants to connect something: they searched the
 * catalog (store, /welcome or from a chat), or opened a guided setup or one
 * of its steps.
 */
export const INTENT_EVENTS: string[] = [
  ProductEvents.CATALOG_SEARCH,
  ProductEvents.SETUP_STARTED,
  ProductEvents.SETUP_STEP_VIEWED,
];

/**
 * Whether a sign-up came through a channel other than typing the address
 * (signup_attributed metadata.first_channel: organic_google, ai_assistant,
 * google_ads, referral…). 'direct' and a missing channel are no intent: most
 * Claude-directory sign-ups arrive that way.
 */
export function attributedIntent(metadata: unknown): boolean {
  const channel = (metadata as { first_channel?: unknown } | null)?.first_channel;
  return typeof channel === 'string' && channel !== '' && channel !== 'direct';
}

