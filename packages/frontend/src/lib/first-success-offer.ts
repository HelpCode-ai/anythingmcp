import { startTrialPath, type CheckoutSource } from './checkout-source';

/**
 * The card-trial offer after a workspace's first successful tool call
 * (AnythingMCP Cloud, admins only). The backend decides who is eligible
 * (GET /api/license/card-trial-offer); this file holds the pure pieces the
 * banner needs: where a checkout came from, the dismissal window and the
 * once-a-day "shown" report. Storage values are passed in, so the helpers can
 * be tested without a browser.
 */

/** Pages that show the offer, reported as `via` on its product events. */
export type OfferVia = 'dashboard' | 'connectors' | 'connect';

/** The offer's in-app card, as `?source=` on /start-trial (its email has its own). */
export const FIRST_SUCCESS_SOURCE: CheckoutSource = 'first_success_banner';

/** After "Not now" the offer stays away this long, on every page. */
export const OFFER_DISMISS_MS = 3 * 24 * 60 * 60 * 1000;

export function offerDismissKey(userId: string): string {
  return `amcp_first_success_offer_dismissed:${userId}`;
}

export function offerShownKey(userId: string): string {
  return `amcp_first_success_offer_shown:${userId}`;
}

/** Whether a stored dismissal (ms since epoch, as a string) still hides the offer. */
export function isOfferDismissed(raw: string | null | undefined, now: number = Date.now()): boolean {
  const at = Number(raw);
  if (!raw || !Number.isFinite(at) || at > now) return false;
  return now - at < OFFER_DISMISS_MS;
}

/** The UTC day, as the once-a-day "shown" report stores it. */
export function offerDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether this render should report `card_trial_offer_shown`: once a day per
 * user and browser, however many pages show the offer and however often they
 * re-render.
 */
export function shouldReportShown(raw: string | null | undefined, now: number = Date.now()): boolean {
  return raw !== offerDay(now);
}

/** "Your AI just ran its first Shopify action." */
export function offerHeadline(connectorName: string | null | undefined): string {
  const name = connectorName?.trim();
  return name ? `Your AI just ran its first ${name} action.` : 'Your AI just ran its first action.';
}

/** The line under it, with the free trial's end ("18 October 2026"), when known. */
export function offerDetail(connectorName: string | null | undefined, trialEnd: string | null): string {
  const what = connectorName?.trim() || 'your connection';
  return trialEnd
    ? `Keep it running: start your trial, and ${what} keeps working after your free trial ends on ${trialEnd}.`
    : `Keep it running: start your trial, and ${what} keeps working after your free trial ends.`;
}

/** Where the offer's button leads: the existing card-trial page, marked. */
export const OFFER_START_PATH = startTrialPath(FIRST_SUCCESS_SOURCE);
