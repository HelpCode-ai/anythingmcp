import { expect, test, type Page } from '@playwright/test';
import {
  CLOUD_PLANS,
  INTENT_TTL_MS,
  cardTrialDisplayEnd,
  cardTrialEligible,
  decodePlanIntent,
  encodePlanIntent,
  formatPlanPrice,
  formatTrialEnd,
  parsePlanIntent,
  yearlyPerMonth,
  yearlySaving,
} from '../../src/lib/card-trial';

/**
 * The card trial on AnythingMCP Cloud: right after sign-up an admin on a
 * running free trial is offered Stripe Checkout with a trial (nothing charged
 * today), once, with a quiet "Continue without payment details" link in the
 * corner that keeps the no-card trial.
 *
 * The first block tests the pure helpers (no browser). The rest uses the same
 * fake session as the other specs: seed the cookie and localStorage, stub
 * /api/* and /health/*.
 */

test.describe('card-trial helpers', () => {
  test('reads the plan the pricing page sends', () => {
    expect(parsePlanIntent('cloud_team', 'yearly')).toEqual({ plan: 'team', period: 'yearly' });
    expect(parsePlanIntent('cloud_starter', null)).toEqual({ plan: 'starter', period: 'monthly' });
    expect(parsePlanIntent('business', 'weekly')).toEqual({ plan: 'business', period: 'monthly' });
    expect(parsePlanIntent('cloud_enterprise', 'monthly')).toBeNull();
    expect(parsePlanIntent(null, 'yearly')).toBeNull();
  });

  test('keeps a stored intent for seven days and no longer', () => {
    const now = Date.UTC(2026, 9, 1);
    const raw = encodePlanIntent({ plan: 'business', period: 'yearly' }, now);
    expect(decodePlanIntent(raw, now + INTENT_TTL_MS - 1)).toEqual({ plan: 'business', period: 'yearly' });
    expect(decodePlanIntent(raw, now + INTENT_TTL_MS + 1)).toBeNull();
    expect(decodePlanIntent('not json', now)).toBeNull();
    expect(decodePlanIntent(JSON.stringify({ plan: 'team', period: 'monthly' }), now)).toBeNull();
    expect(decodePlanIntent(null, now)).toBeNull();
  });

  test('offers the card trial to cloud admins on a running trial only', () => {
    const now = Date.UTC(2026, 9, 1);
    const trial = { plan: 'trial', status: 'active', expiresAt: new Date(now + 3 * 86_400_000).toISOString() };
    expect(cardTrialEligible({ isCloud: true, role: 'ADMIN', license: trial, now })).toBe(true);
    expect(cardTrialEligible({ isCloud: false, role: 'ADMIN', license: trial, now })).toBe(false);
    expect(cardTrialEligible({ isCloud: true, role: 'EDITOR', license: trial, now })).toBe(false);
    expect(
      cardTrialEligible({ isCloud: true, role: 'ADMIN', license: { ...trial, expiresAt: new Date(now - 1).toISOString() }, now }),
    ).toBe(false);
    expect(cardTrialEligible({ isCloud: true, role: 'ADMIN', license: { ...trial, plan: 'cloud_team' }, now })).toBe(false);
    expect(cardTrialEligible({ isCloud: true, role: 'ADMIN', license: null, now })).toBe(false);
    // Under 48 hours left: no card trial (it would have to be lengthened).
    expect(
      cardTrialEligible({ isCloud: true, role: 'ADMIN', license: { ...trial, expiresAt: new Date(now + 86_400_000).toISOString() }, now }),
    ).toBe(false);
  });

  test('the card trial ends with the free trial, and needs 48 hours of it left', () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const inFiveDays = new Date(now + 5 * 86_400_000).toISOString();
    expect(cardTrialDisplayEnd(inFiveDays, now)).toBe(inFiveDays);
    expect(cardTrialDisplayEnd(new Date(now + 3_600_000).toISOString(), now)).toBeNull();
    expect(cardTrialDisplayEnd(null, now)).toBeNull();
  });

  test('formats the trial end and the prices', () => {
    expect(formatTrialEnd('2026-10-07T09:00:00.000Z', 'long', 'UTC')).toBe('7 October 2026');
    expect(formatTrialEnd('2026-10-07T09:00:00.000Z', 'short', 'UTC')).toBe('7 Oct');
    expect(formatTrialEnd('nonsense')).toBeNull();

    const [starter, team, business] = CLOUD_PLANS;
    expect(formatPlanPrice(team, 'monthly')).toBe('49 €/month');
    expect(formatPlanPrice(starter, 'yearly')).toBe('190 €/year');
    expect(yearlyPerMonth(starter)).toBe(15.83);
    expect(yearlyPerMonth(business)).toBe(82.5);
    expect(CLOUD_PLANS.map(yearlySaving)).toEqual([38, 98, 198]);
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

const TRIAL_END = new Date(Date.now() + 5 * 86_400_000).toISOString();

async function cloudSession(
  page: Page,
  opts: {
    user?: typeof ADMIN;
    seed?: Record<string, string>;
    license?: Record<string, unknown>;
    checkout?: (body: unknown) => { status: number; body: unknown };
  } = {},
) {
  const user = opts.user ?? ADMIN;
  const posted: unknown[] = [];
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript(
    ({ user, seed }) => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify(user));
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    },
    { user, seed: opts.seed ?? {} },
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/license/checkout-link') && req.method() === 'POST') {
      const body = req.postDataJSON();
      posted.push(body);
      const reply = opts.checkout
        ? opts.checkout(body)
        : { status: 200, body: { url: 'https://checkout.example.test/start?intent=i1' } };
      return json(reply.body, reply.status);
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: null });
    if (p.endsWith('/users/me')) return json(user);
    if (p.endsWith('/license/status')) {
      return json(
        opts.license ?? { plan: 'trial', status: 'active', expiresAt: TRIAL_END, trialDaysLeft: 5, features: {} },
      );
    }
    if (p.endsWith('/license/usage')) {
      return json({ plan: 'trial', connectors: { current: 0, max: 2, isOver: false }, mcpServers: { current: 0, max: 2, isOver: false }, users: { current: 1, max: 1, isOver: false }, isOverAny: false });
    }
    if (p.endsWith('/adapters/starter-pack')) return json([]);
    if (p.endsWith('/connectors') || p.endsWith('/adapters')) return json([]);
    return json({});
  });
  await page.route('https://checkout.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe Checkout stub</h1>' }),
  );
  return { posted };
}

test.describe('card-trial offer (cloud)', () => {
  test('a new cloud admin is offered the card trial once, and can skip it quietly', async ({ page }) => {
    await cloudSession(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/start-trial$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Your 7-day free trial' })).toBeVisible();
    await expect(page.getByText('€0 today.')).toBeVisible();
    // Team is preselected without an intent from the pricing page.
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');

    // The skip is a small link, not a button styled as one.
    const skip = page.getByRole('button', { name: 'Continue without payment details' });
    await expect(skip).toHaveClass(/text-xs/);
    await skip.click();

    // On to the normal onboarding, and not offered again.
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
    expect(await page.evaluate(() => localStorage.getItem('amcp_card_trial_prompt:u1'))).toBe('skipped');
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
  });

  test('Start free trial opens Checkout for the chosen plan with a trial', async ({ page }) => {
    const { posted } = await cloudSession(page, { seed: { 'amcp_card_trial_prompt:u1': 'shown' } });
    await page.goto('/start-trial');
    await page.getByRole('radio', { name: 'Yearly' }).click();
    await page.getByRole('radio', { name: /Starter/ }).click();
    await expect(page.getByText('190 €/year')).toBeVisible();
    await page.getByRole('button', { name: 'Start free trial' }).click();

    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'yearly', trial: true }]);
  });

  test('a failed checkout shows a friendly error and can be retried', async ({ page }) => {
    let calls = 0;
    await cloudSession(page, {
      seed: { 'amcp_card_trial_prompt:u1': 'shown' },
      checkout: () =>
        ++calls === 1
          ? { status: 502, body: { message: 'upstream detail' } }
          : { status: 200, body: { url: 'https://checkout.example.test/start?intent=i2' } },
    });
    await page.goto('/start-trial');
    await page.getByRole('button', { name: 'Start free trial' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'checkout' });
    await expect(alert).toContainText('could not open the checkout');
    await expect(alert).not.toContainText('upstream detail');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i2');
  });

  test('the plan picked on the pricing page survives sign-up and is preselected', async ({ page }) => {
    await cloudSession(page, { seed: { 'amcp_card_trial_prompt:u1': 'shown' } });
    // Signed out on the register page first (the cookie is irrelevant there).
    await page.goto('/login?mode=register&plan=cloud_business&period=yearly');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('amcp_plan_intent')), { timeout: 15_000 })
      .toContain('"plan":"business"');

    await page.goto('/start-trial');
    await expect(page.getByRole('radio', { name: /Business/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a non-admin is never shown the offer', async ({ page }) => {
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' } });
    await page.goto('/start-trial');
    await expect(page).not.toHaveURL(/\/start-trial$/, { timeout: 15_000 });
  });
});

test.describe('card-trial entry points (cloud)', () => {
  const SHOWN = { 'amcp_card_trial_prompt:u1': 'shown' };

  test('the trial banner offers a card and, without a picked plan, opens the picker', async ({ page }) => {
    const { posted } = await cloudSession(page, { seed: SHOWN });
    await page.goto('/connectors');
    const cta = page.getByRole('button', { name: /Add a payment method — no charge before/ });
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();
    await expect(page).toHaveURL(/\/start-trial$/);
    expect(posted).toEqual([]);
  });

  test('the trial banner goes straight to Checkout for the plan picked on the pricing page', async ({ page }) => {
    const intent = JSON.stringify({ plan: 'business', period: 'monthly', savedAt: Date.now() });
    const { posted } = await cloudSession(page, { seed: { ...SHOWN, amcp_plan_intent: intent } });
    await page.goto('/connectors');
    await page.getByRole('button', { name: /Add a payment method/ }).click({ timeout: 15_000 });
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'business', billingPeriod: 'monthly', trial: true }]);
  });

  test('after the trial, an admin buys the chosen plan from the licence wall, without a trial', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      seed: SHOWN,
      license: { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() - 86_400_000).toISOString(), trialDaysLeft: 0 },
    });
    await page.goto('/connectors');
    await expect(page.getByRole('heading', { name: 'Your Trial Has Expired' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Compare plans' })).toBeVisible();
    await page.getByRole('radio', { name: /Starter/ }).click();
    await page.getByRole('button', { name: 'Subscribe to Starter' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'monthly', trial: false }]);
  });

  test('a non-admin keeps the plain pricing link in the banner', async ({ page }) => {
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' }, seed: SHOWN });
    await page.goto('/connectors');
    await expect(page.getByRole('link', { name: 'Upgrade now' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Add a payment method/ })).toHaveCount(0);
  });
});
