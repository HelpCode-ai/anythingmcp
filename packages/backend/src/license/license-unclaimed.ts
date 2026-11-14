import { normalizeEmail } from '../common/email.util';

/**
 * Paid Cloud licences that were sold but never reached a workspace.
 *
 * A checkout started from the public pricing page (the links in the trial and
 * win-back emails, the link an AI client gets when an ended trial blocks a
 * tool call) knows the buyer's address but not their workspace. The licence
 * then reaches this server only if the buyer's browser comes back to
 * /settings/license/activate, signed in, in the same tab. When it does not,
 * the customer pays while their workspace stays an ended trial: on 2 Nov 2026
 * sixteen paid licences, the oldest from 9 Oct, had never been activated.
 *
 * The licence site lists them (POST /api/license/unclaimed, service token)
 * and LicenseService.bindUnclaimedPaidLicences binds each one to the
 * workspace of the account with the same verified address.
 *
 * It ran once an hour from the onboarding cron, and the site held a licence
 * back for its first 15 minutes, so a buyer whose browser did not come back
 * waited up to 75 minutes for the plan they had paid for (5 Nov 2026). The
 * Cloud now asks every minute (UNCLAIMED_SWEEP_MS) and binds a licence once
 * it is UNCLAIMED_SETTLE_MS old: about two minutes after the payment.
 */

/** How often the Cloud backend asks the licence site for unclaimed licences. */
export const UNCLAIMED_SWEEP_MS = 60 * 1000;

/**
 * A licence is left this long after the purchase, so the buyer's own browser,
 * coming back from Stripe to /settings/license/activate, binds it first: that
 * one knows the workspace for certain, the address match only guesses it.
 * The site applies the same delay; this keeps it if the site does not.
 */
export const UNCLAIMED_SETTLE_MS = 2 * 60 * 1000;

/** One entry of the licence site's answer. */
export interface UnclaimedLicence {
  key: string;
  /** Normalised (trimmed, lower case), as Cloud stores its users' addresses. */
  email: string;
  plan: string;
  /** Set when the checkout was started inside the app and named the workspace. */
  organizationId?: string;
  /** When the licence was sold, when the site says. */
  createdAt?: Date;
}

const KEY_RE = /^AMCP-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

/**
 * The licence site's `{ licences: [...] }`, keeping only well-formed entries.
 * Null when the answer is not that shape at all.
 */
export function parseUnclaimedLicences(data: unknown): UnclaimedLicence[] | null {
  const raw = (data as { licences?: unknown } | null | undefined)?.licences;
  if (!Array.isArray(raw)) return null;
  const out: UnclaimedLicence[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, email, plan, organizationId, createdAt } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || !KEY_RE.test(key) || seen.has(key)) continue;
    if (typeof email !== 'string' || !email.includes('@')) continue;
    seen.add(key);
    const sold = typeof createdAt === 'string' ? new Date(createdAt) : null;
    out.push({
      key,
      email: normalizeEmail(email),
      plan: typeof plan === 'string' ? plan : '',
      ...(typeof organizationId === 'string' && organizationId ? { organizationId } : {}),
      ...(sold && !Number.isNaN(sold.getTime()) ? { createdAt: sold } : {}),
    });
  }
  return out;
}

/**
 * Whether a listed licence is old enough to bind (UNCLAIMED_SETTLE_MS). One
 * without a sale date is: the site only lists licences it has held back.
 */
export function isSettled(licence: UnclaimedLicence, now: Date): boolean {
  return !licence.createdAt || now.getTime() - licence.createdAt.getTime() >= UNCLAIMED_SETTLE_MS;
}

/** Why a listed licence was left unbound this run. */
export type UnclaimedSkipReason =
  /** No verified account with the licence's address. */
  | 'no_account'
  /** The account is not an administrator of its workspace. */
  | 'not_admin'
  /** The workspace the checkout named no longer exists. */
  | 'no_workspace'
  /** The workspace already has a live paid licence: probably a second subscription. */
  | 'already_paid'
  /** The key is already bound here to another workspace. */
  | 'bound_elsewhere';

/**
 * The skip counts for the summary log line, e.g. " (no_account=2, not_admin=1)",
 * in a fixed order; empty when nothing was skipped.
 */
export function formatSkipReasons(counts: ReadonlyMap<UnclaimedSkipReason, number>): string {
  const order: UnclaimedSkipReason[] = ['no_account', 'not_admin', 'no_workspace', 'already_paid', 'bound_elsewhere'];
  const parts = order.filter((r) => (counts.get(r) ?? 0) > 0).map((r) => `${r}=${counts.get(r)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
