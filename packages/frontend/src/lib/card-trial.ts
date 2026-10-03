import { storage } from './storage';
import { safeRedirect } from './safe-redirect';

/**
 * The card trial on AnythingMCP Cloud: right after sign-up an admin is offered
 * Stripe Checkout with a 7-day trial (card required, nothing charged today),
 * ending when their free trial would have. Everything here is Cloud only;
 * self-hosted builds never call it.
 *
 * Pure helpers live here so they can be tested without a browser; the pieces
 * that touch storage go through `storage`, which never throws.
 */

export type CloudPlanId = 'starter' | 'team' | 'business';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanSelection {
  plan: CloudPlanId;
  period: BillingPeriod;
}

export interface CloudPlan {
  id: CloudPlanId;
  name: string;
  /** EUR incl. VAT per month, on monthly billing. */
  monthly: number;
  /** EUR incl. VAT per year, on yearly billing. */
  yearly: number;
  summary: string;
  popular?: boolean;
}

/**
 * Mirrors anythingmcp.com/pricing and the live Stripe prices (Cloud plans,
 * EUR incl. VAT). Keep in step with the marketing site when a price changes:
 * the checkout charges what Stripe says, this only describes it.
 */
export const CLOUD_PLANS: readonly CloudPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    monthly: 19,
    yearly: 190,
    summary: '5 connectors · 3 MCP servers · 1 user',
  },
  {
    id: 'team',
    name: 'Team',
    monthly: 49,
    yearly: 490,
    summary: '15 connectors · 10 MCP servers · up to 3 users',
    popular: true,
  },
  {
    id: 'business',
    name: 'Business',
    monthly: 99,
    yearly: 990,
    summary: 'Unlimited connectors and MCP servers · up to 10 users',
  },
];

export const DEFAULT_SELECTION: PlanSelection = { plan: 'team', period: 'monthly' };

export function planById(id: CloudPlanId): CloudPlan {
  return CLOUD_PLANS.find((p) => p.id === id) ?? CLOUD_PLANS[1];
}

/** "19 €", "15.83 €" (non-breaking space, as on the invoice). */
export function formatEur(amount: number): string {
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${text} €`;
}

/** The price line for a plan: "49 €/month" or "490 €/year". */
export function formatPlanPrice(plan: CloudPlan, period: BillingPeriod): string {
  return period === 'yearly' ? `${formatEur(plan.yearly)}/year` : `${formatEur(plan.monthly)}/month`;
}

/** The monthly equivalent of a yearly price, rounded to the cent: 190 → 15.83. */
export function yearlyPerMonth(plan: CloudPlan): number {
  return Math.round((plan.yearly / 12) * 100) / 100;
}

/** What yearly billing saves over twelve months of monthly billing. */
export function yearlySaving(plan: CloudPlan): number {
  return plan.monthly * 12 - plan.yearly;
}

// ── Plan intent from the pricing page ───────────────────────────────────────

/**
 * The pricing page opens sign-up as `?mode=register&plan=cloud_team&period=yearly`.
 * Accepts `cloud_<tier>` or the bare tier; anything else is no intent at all.
 * A missing or unknown period falls back to monthly.
 */
export function parsePlanIntent(
  plan: string | null | undefined,
  period: string | null | undefined,
): PlanSelection | null {
  if (!plan) return null;
  const tier = plan.trim().toLowerCase().replace(/^cloud_/, '');
  if (tier !== 'starter' && tier !== 'team' && tier !== 'business') return null;
  const p = (period ?? '').trim().toLowerCase();
  return { plan: tier, period: p === 'yearly' || p === 'annual' ? 'yearly' : 'monthly' };
}

const INTENT_KEY = 'amcp_plan_intent';
/**
 * Long enough to survive email verification, which may happen days later and
 * in another tab (hence localStorage, not sessionStorage).
 */
export const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function encodePlanIntent(sel: PlanSelection, now: number = Date.now()): string {
  return JSON.stringify({ plan: sel.plan, period: sel.period, savedAt: now });
}

/** A stored intent, or null when missing, malformed or older than the TTL. */
export function decodePlanIntent(raw: string | null, now: number = Date.now()): PlanSelection | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const savedAt = Number(data.savedAt);
    if (!Number.isFinite(savedAt) || savedAt > now || now - savedAt > INTENT_TTL_MS) return null;
    return parsePlanIntent(String(data.plan ?? ''), String(data.period ?? ''));
  } catch {
    return null;
  }
}

export function savePlanIntent(sel: PlanSelection): void {
  storage.set(INTENT_KEY, encodePlanIntent(sel));
}

export function readPlanIntent(): PlanSelection | null {
  const raw = storage.get(INTENT_KEY);
  const sel = decodePlanIntent(raw);
  if (raw && !sel) storage.remove(INTENT_KEY);
  return sel;
}

// ── Promotion code from the pricing page ────────────────────────────────────

const PROMO_KEY = 'amcp_promo_code';

/** A Stripe promotion code as the site passes it (`&promo=START30`), or null. */
export function parsePromoCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code.toUpperCase() : null;
}

/**
 * Kept beside the plan intent, with the same lifetime, so a visitor who came
 * through the promo bar still gets the discount on the card trial they start
 * after verifying their email.
 */
export function savePromoCode(code: string): void {
  storage.set(PROMO_KEY, JSON.stringify({ code, savedAt: Date.now() }));
}

export function readPromoCode(now: number = Date.now()): string | null {
  const raw = storage.get(PROMO_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const savedAt = Number(data?.savedAt);
    const code = parsePromoCode(data?.code);
    if (code && Number.isFinite(savedAt) && savedAt <= now && now - savedAt <= INTENT_TTL_MS) return code;
  } catch {
    /* fall through */
  }
  storage.remove(PROMO_KEY);
  return null;
}

// ── Eligibility and the one-time prompt ─────────────────────────────────────

export interface TrialStatusLike {
  plan: string | null;
  status: string;
  expiresAt?: string | null;
  trialDaysLeft?: number;
}

/**
 * Whether the card trial is on offer: Cloud, an admin, and a free trial that
 * is still running. Other roles cannot start a subscription, and after the
 * trial there is nothing left to trial (the licence wall sells the plan).
 */
export function cardTrialEligible(input: {
  isCloud: boolean;
  role: string | null | undefined;
  license: TrialStatusLike | null | undefined;
  now?: number;
}): boolean {
  const { isCloud, role, license } = input;
  if (!isCloud || role !== 'ADMIN' || !license) return false;
  if (license.plan !== 'trial' || license.status !== 'active') return false;
  // Stripe needs the trial end at least 48 hours out. With less left, the
  // trial is not stretched to fit: the regular upgrade (pay now) applies.
  if (license.expiresAt) {
    const end = new Date(license.expiresAt).getTime();
    return Number.isFinite(end) && end >= (input.now ?? Date.now()) + MIN_CARD_TRIAL_MS;
  }
  return typeof license.trialDaysLeft === 'number' && license.trialDaysLeft > 2;
}

/** 'shown': sent to /start-trial once; 'skipped' / 'checkout': chose. */
export type CardTrialPrompt = 'shown' | 'skipped' | 'checkout';

export function cardTrialPromptKey(userId: string): string {
  return `amcp_card_trial_prompt:${userId}`;
}

export function readCardTrialPrompt(userId: string): CardTrialPrompt | null {
  const v = storage.get(cardTrialPromptKey(userId));
  return v === 'shown' || v === 'skipped' || v === 'checkout' ? v : null;
}

export function writeCardTrialPrompt(userId: string, value: CardTrialPrompt): void {
  storage.set(cardTrialPromptKey(userId), value);
}

/**
 * Stripe wants a trial to end at least 48 hours out. The card trial ends when
 * the free trial does, and is only offered while that is at least this far
 * away (the licence site sells without a trial otherwise, rather than
 * lengthening it). Mirrors the licence site's rule.
 */
export const MIN_CARD_TRIAL_MS = 48 * 60 * 60 * 1000;

/** The date the card trial would end (the free trial's end), or null if none is possible. */
export function cardTrialDisplayEnd(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (!Number.isFinite(end) || end < now + MIN_CARD_TRIAL_MS) return null;
  return new Date(end).toISOString();
}

/**
 * The trial end as shown to the user: "7 October 2026" (long) or "7 Oct"
 * (short), in their own time zone. English, like the rest of the UI.
 */
export function formatTrialEnd(
  iso: string | null | undefined,
  style: 'long' | 'short' = 'long',
  timeZone?: string,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    ...(style === 'long' && { year: 'numeric' }),
    ...(timeZone && { timeZone }),
  });
}

// ── Back to an AI client's authorization ────────────────────────────────────

/**
 * Someone who signs up from "Connect" in Claude is offered the card trial
 * before approving the connection. The authorization waits for them (the
 * backend keeps it 30 minutes), so the way back is remembered across the
 * detour: skipping, a cancelled checkout (Stripe returns to /start-trial) and
 * a completed one (the licence site returns to /settings/license/activate)
 * all end on the same consent page.
 *
 * localStorage, not sessionStorage: Stripe can open in another tab on some
 * mobile browsers. Only the backend's own /auth/ pages qualify.
 */
const AUTH_RETURN_KEY = 'amcp_card_trial_return';
export const AUTH_RETURN_TTL_MS = 30 * 60 * 1000;

export function isAuthorizationPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/auth/') && safeRedirect(path, '') === path;
}

export function saveAuthorizationReturn(path: string, now: number = Date.now()): void {
  if (!isAuthorizationPath(path)) return;
  storage.set(AUTH_RETURN_KEY, JSON.stringify({ path, savedAt: now }));
}

/** The consent page to go back to, or null when none is waiting (or it expired). */
export function readAuthorizationReturn(now: number = Date.now()): string | null {
  const raw = storage.get(AUTH_RETURN_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const savedAt = Number(data?.savedAt);
    if (
      isAuthorizationPath(data?.path) &&
      Number.isFinite(savedAt) &&
      savedAt <= now &&
      now - savedAt <= AUTH_RETURN_TTL_MS
    ) {
      return data.path;
    }
  } catch {
    /* fall through */
  }
  storage.remove(AUTH_RETURN_KEY);
  return null;
}

export function clearAuthorizationReturn(): void {
  storage.remove(AUTH_RETURN_KEY);
}

/**
 * Where to go after the card-trial offer: the waiting authorization if there
 * is one (spent here, so it is followed once), otherwise `fallback`.
 */
export function takeAuthorizationReturn(fallback: string): string {
  const path = readAuthorizationReturn();
  clearAuthorizationReturn();
  return path ?? fallback;
}
