import { expect, test, type Page } from '@playwright/test';
import { describeBilling } from '../../src/lib/billing-summary';
import { parsePromoCode } from '../../src/lib/card-trial';
import { shouldShowSubscriptionBanner } from '../../src/components/subscription-banner';

/**
 * The app used to know a paid licence only as "active": a card-trial customer
 * never saw when the first charge comes, a customer who cancelled never saw
 * when the plan ends, and cancelling meant finding Stripe's portal home. The
 * licence status now carries the subscription's state.
 *
 * Also: a promotion code from the pricing page (promo bar) rides through
 * sign-up into the card trial's checkout.
 */

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const billing = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  cancelling: false,
  endsAt: null,
  currentPeriodEnd: iso(Date.now() + 20 * DAY),
  trialEnd: null,
  amount: 4900,
  currency: 'eur',
  interval: 'month',
  ...over,
});

test.describe('billing helpers', () => {
  test('says when a card trial turns into a charge, and for how much', () => {
    const s = describeBilling(billing({ status: 'trialing', trialEnd: '2026-10-08T09:00:00Z' }) as any, 'en-GB');
    expect(s?.tone).toBe('info');
    expect(s?.text).toContain('Free trial until 8 October 2026');
    expect(s?.text).toContain('€49.00/month');
  });

  test('a cancelled plan says when it ends and offers to keep it', () => {
    const s = describeBilling(billing({ cancelling: true, endsAt: '2026-11-01T00:00:00Z' }) as any, 'en-GB');
    expect(s).toMatchObject({ tone: 'warn', cancelling: true });
    expect(s?.text).toContain('ends on 1 November 2026');
  });

  test('a cancelled card trial says nothing will be charged', () => {
    const s = describeBilling(
      billing({ status: 'trialing', cancelling: true, endsAt: '2026-10-08T09:00:00Z' }) as any,
      'en-GB',
    );
    expect(s?.text).toContain("you won't be charged");
  });

  test('a failed payment is a danger notice', () => {
    expect(describeBilling(billing({ status: 'past_due' }) as any)).toMatchObject({
      tone: 'danger',
      paymentIssue: true,
    });
  });

  test('the banner shows only when there is something to act on soon', () => {
    const now = Date.now();
    expect(shouldShowSubscriptionBanner(billing() as any, now)).toBe(false);
    expect(shouldShowSubscriptionBanner(billing({ status: 'past_due' }) as any, now)).toBe(true);
    expect(
      shouldShowSubscriptionBanner(billing({ cancelling: true, endsAt: iso(now + 5 * DAY) }) as any, now),
    ).toBe(true);
    expect(
      shouldShowSubscriptionBanner(billing({ cancelling: true, endsAt: iso(now + 20 * DAY) }) as any, now),
    ).toBe(false);
    expect(
      shouldShowSubscriptionBanner(billing({ status: 'trialing', trialEnd: iso(now + 2 * DAY) }) as any, now),
    ).toBe(true);
    expect(
      shouldShowSubscriptionBanner(billing({ status: 'trialing', trialEnd: iso(now + 6 * DAY) }) as any, now),
    ).toBe(false);
    expect(shouldShowSubscriptionBanner(undefined, now)).toBe(false);
  });

  test('reads a promotion code and refuses junk', () => {
    expect(parsePromoCode(' start30 ')).toBe('START30');
    expect(parsePromoCode('WINBACK_50')).toBe('WINBACK_50');
    expect(parsePromoCode('bad code!')).toBeNull();
    expect(parsePromoCode(null)).toBeNull();
  });
});

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function cloudSession(
  page: Page,
  opts: { license?: Record<string, unknown>; seed?: Record<string, string>; signedIn?: boolean } = {},
) {
  const posted: { path: string; body: unknown }[] = [];
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  if (opts.signedIn !== false) {
    await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  }
  await page.addInitScript(
    ({ user, seed, signedIn }) => {
      if (signedIn) {
        localStorage.setItem('amcp_token', 't');
        localStorage.setItem('amcp_user', JSON.stringify(user));
      }
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    },
    { user: ADMIN, seed: opts.seed ?? {}, signedIn: opts.signedIn !== false },
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (req.method() === 'POST' && (p.endsWith('/license/billing-portal') || p.endsWith('/license/checkout-link'))) {
      posted.push({ path: p, body: req.postDataJSON() });
      return json({ url: 'https://billing.example.test/session' });
    }
    if (p.endsWith('/license/refresh')) return json({ refreshed: false });
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) {
      return json(opts.license ?? { plan: 'team', status: 'active', expiresAt: null, features: {}, billing: billing() });
    }
    if (p.endsWith('/license/usage')) {
      return json({ plan: 'team', connectors: { current: 1, max: 15, isOver: false }, mcpServers: { current: 1, max: 10, isOver: false }, users: { current: 1, max: 3, isOver: false }, isOverAny: false });
    }
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/mcp-servers')) return json([]);
    return json({});
  });
  await page.route('https://billing.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe portal stub</h1>' }),
  );
  return { posted };
}

test.describe('subscription state in the app (cloud)', () => {
  test('a renewing plan shows its renewal and a labelled way to cancel, straight to Stripe', async ({ page }) => {
    const { posted } = await cloudSession(page);
    await page.goto('/settings/license');
    await expect(page.getByText(/Renews on .* for €49\.00\/month/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Cancel subscription' }).click();
    await expect(page).toHaveURL('https://billing.example.test/session');
    expect(posted[0].path).toMatch(/billing-portal$/);
    expect(posted[0].body).toMatchObject({ flow: 'cancel' });
  });

  test('a cancelled plan says when it ends and offers to keep it, not to cancel again', async ({ page }) => {
    await cloudSession(page, {
      license: {
        plan: 'team',
        status: 'active',
        expiresAt: null,
        features: {},
        billing: billing({ cancelling: true, endsAt: iso(Date.now() + 4 * DAY) }),
      },
    });
    await page.goto('/settings/license');
    await expect(page.getByRole('status').filter({ hasText: 'Your subscription is cancelled' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Keep my plan' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);
    // In its last week the app-wide banner says so too.
    await expect(page.getByRole('link', { name: 'Keep my plan' })).toBeVisible();
  });

  test('a failed payment shows a banner that cannot be dismissed', async ({ page }) => {
    await cloudSession(page, {
      license: { plan: 'team', status: 'active', expiresAt: null, features: {}, billing: billing({ status: 'past_due' }) },
    });
    await page.goto('/settings/license');
    await expect(page.getByRole('link', { name: 'Update payment method' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  });
});

test.describe('promotion code through sign-up (cloud)', () => {
  test('a code on the sign-up link is kept and applied to the card trial checkout', async ({ page }) => {
    await cloudSession(page, { signedIn: false });
    await page.goto('/login?mode=register&plan=cloud_team&period=monthly&promo=start30');
    await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible({ timeout: 15_000 });
    const stored = await page.evaluate(() => localStorage.getItem('amcp_promo_code'));
    expect(JSON.parse(stored ?? '{}').code).toBe('START30');
  });

  test('the trial offer names the code and sends it with the checkout', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      license: {
        plan: 'trial',
        status: 'active',
        expiresAt: iso(Date.now() + 5 * DAY),
        trialDaysLeft: 5,
        features: {},
      },
      seed: {
        'amcp_card_trial_prompt:u1': 'shown',
        amcp_promo_code: JSON.stringify({ code: 'START30', savedAt: Date.now() }),
      },
    });
    await page.goto('/start-trial');
    await expect(page.getByText('Code START30 will be applied at checkout.')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Start free trial' }).click();
    await expect(page).toHaveURL('https://billing.example.test/session');
    expect(posted[0].body).toMatchObject({ trial: true, promo: 'START30' });
  });
});
