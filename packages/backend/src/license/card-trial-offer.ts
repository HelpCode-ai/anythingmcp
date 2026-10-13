import { CARD_TRIAL_MIN_LEAD_MS } from './license-checkout';

/**
 * The card-trial offer after a workspace's first successful tool call
 * (AnythingMCP Cloud only).
 *
 * The card trial used to be offered only at sign-up, before anyone had seen
 * the product work. A workspace on the no-card trial that makes its first
 * successful call is now "eligible for the post-success offer": its admins see
 * a dismissible card on the dashboard and the connect pages, and get one email
 * 30 to 90 minutes later. Nothing of it reaches an MCP tool response.
 *
 * Pure helpers shared by FirstSuccessService (marks eligibility on the call
 * path), CardTrialOfferService (the in-app offer and the email) and the tests.
 */

/** OrgSettings: when the workspace made its first successful tool call (ISO). */
export const FIRST_SUCCESS_KEY = 'first_successful_call_at';
/**
 * OrgSettings: when the workspace became eligible (ISO). Created with ON
 * CONFLICT DO NOTHING, so of two processes seeing the first success at once
 * only one records the product event.
 */
export const OFFER_ELIGIBLE_KEY = 'card_trial_offer_eligible_at';
/**
 * OrgSettings: the offer email is settled. An ISO time when it was sent, or
 * `skipped:<reason>` when it never will be. Its presence alone stops a send.
 */
export const OFFER_EMAIL_KEY = 'card_trial_offer_email';

/** `?source=` on /start-trial, carried into the checkout and Stripe metadata. */
export const FIRST_SUCCESS_SOURCE = 'first_success';

/**
 * A first success older than this when we first see it does not make the
 * workspace eligible: it activated before this feature shipped (or long ago),
 * and its "aha" moment has passed.
 */
export const FIRST_SUCCESS_FRESH_MS = 24 * 60 * 60 * 1000;

/** The email goes out no sooner than this after the workspace became eligible. */
export const OFFER_EMAIL_AFTER_MS = 30 * 60 * 1000;
/** And not at all later than this: a late "your connection works" is noise. */
export const OFFER_EMAIL_UNTIL_MS = 48 * 60 * 60 * 1000;
/** No offer email within this long of another lifecycle or onboarding email. */
export const OFFER_EMAIL_QUIET_MS = 12 * 60 * 60 * 1000;

/**
 * OrgSettings flags the other Cloud emails leave behind (onboarding cron):
 * trial lifecycle (3 days, 1 day, ended) and win-back. Their `updatedAt` is
 * when they were sent or settled.
 */
export const OTHER_TRIAL_EMAIL_KEYS = [
  'trial_email_warn3',
  'trial_email_warn1',
  'trial_email_expired',
  'trial_email_winback7',
  'trial_email_winback30',
] as const;

export interface OfferLicence {
  plan: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Where a workspace stands for the offer, from all its licence rows:
 * - `customer`: any licence other than the free trial, in any state. A paid
 *   plan, a card trial (a 'starter'/'team' licence while Stripe says
 *   trialing), or a former customer whose subscription lapsed. The same rule
 *   the win-back uses: none of them is offered a trial.
 * - `no_trial`: no licence at all (the trial was never mirrored).
 * - `trial_ended`: the free trial is over or no longer active.
 * - `eligible`: a running free trial, without a card.
 */
export type OfferLicenceState = 'eligible' | 'customer' | 'no_trial' | 'trial_ended';

export function offerLicenceState(licences: OfferLicence[], now: Date = new Date()): OfferLicenceState {
  if (licences.some((l) => l.plan !== 'trial')) return 'customer';
  if (licences.length === 0) return 'no_trial';
  // The current licence is the newest active one (LicenseService.getCurrentLicense).
  const current = licences
    .filter((l) => l.status === 'active')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!current?.expiresAt) return 'trial_ended';
  return current.expiresAt.getTime() > now.getTime() ? 'eligible' : 'trial_ended';
}

/** When the running free trial ends, for an eligible workspace; null otherwise. */
export function offerTrialEnd(licences: OfferLicence[], now: Date = new Date()): Date | null {
  if (offerLicenceState(licences, now) !== 'eligible') return null;
  const current = licences
    .filter((l) => l.status === 'active')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return current?.expiresAt ?? null;
}

/**
 * Whether a card trial can still start: Stripe needs its end at least 48 hours
 * out, and the card trial ends when the free trial does (license-checkout.ts).
 * With less left, /start-trial sends the user away, so the in-app offer is
 * hidden and the email links to the plans instead.
 */
export function cardTrialStillAvailable(trialEndsAt: Date | null, now: Date = new Date()): boolean {
  return !!trialEndsAt && trialEndsAt.getTime() >= now.getTime() + CARD_TRIAL_MIN_LEAD_MS;
}

/**
 * Tools that are about the API rather than about the user's data: playbooks,
 * schema helpers, account checks. Not what anyone wants to ask next.
 */
const META_TOOL = /(playbook|_guide$|_schema(_url)?$|_graphql_|how_to_obtain|whoami|account_info|_ping$|health)/i;
/** Reads come first: a safe, useful thing to try is to look something up. */
const READ_TOOL = /(^|_)(list|search|get|find|query|lookup|report|summary|top|count|recent)(_|$)/i;
const MAX_STEP_CHARS = 140;

/** The first sentence of a tool description, without markdown, capped. */
export function firstSentence(description: string | null | undefined): string | null {
  if (!description) return null;
  const plain = description
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  const match = plain.match(/^(.+?[.!?])(\s|$)/);
  let sentence = (match ? match[1] : plain).trim();
  if (sentence.length > MAX_STEP_CHARS) {
    sentence = `${sentence.slice(0, MAX_STEP_CHARS - 1).replace(/[\s,;:.-]+\S*$/, '')}…`;
  }
  // Long dashes read as machine-written; the copy uses none.
  sentence = sentence.replace(/\s*[—–]\s*/g, ', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Up to `max` concrete next things for the email, from the connector's own
 * enabled tools: not the tool that was just used, not meta tools, reads first,
 * one per distinct description.
 */
export function pickNextSteps(
  tools: Array<{ name: string; description: string | null }>,
  usedToolName?: string | null,
  max = 3,
): Array<{ name: string; text: string }> {
  const candidates = tools
    .filter((t) => t.name !== usedToolName && !META_TOOL.test(t.name))
    .map((t, index) => ({ name: t.name, text: firstSentence(t.description), index, read: READ_TOOL.test(t.name) }))
    .filter((t): t is { name: string; text: string; index: number; read: boolean } => !!t.text && t.text.length >= 12);
  candidates.sort((a, b) => Number(b.read) - Number(a.read) || a.index - b.index);
  const seen = new Set<string>();
  const out: Array<{ name: string; text: string }> = [];
  for (const c of candidates) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: c.name, text: c.text });
    if (out.length >= max) break;
  }
  return out;
}
