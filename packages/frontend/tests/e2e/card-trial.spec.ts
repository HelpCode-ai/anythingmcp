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
  purchaseDestination,
  trialRunning,
  yearlyPerMonth,
  yearlySaving,
} from '../../src/lib/card-trial';
import { formatLocal, parseLocalPricing } from '../../src/lib/local-currency';

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
    expect(parsePlanIntent('team', 'weekly')).toEqual({ plan: 'team', period: 'monthly' });
    expect(parsePlanIntent('cloud_enterprise', 'monthly')).toBeNull();
    // Retired on 8 Oct 2026; an old link falls back to the default selection.
    expect(parsePlanIntent('cloud_business', 'monthly')).toBeNull();
    expect(parsePlanIntent(null, 'yearly')).toBeNull();
  });

  test('keeps a stored intent for seven days and no longer', () => {
    const now = Date.UTC(2026, 9, 1);
    const raw = encodePlanIntent({ plan: 'team', period: 'yearly' }, now);
    expect(decodePlanIntent(raw, now + INTENT_TTL_MS - 1)).toEqual({ plan: 'team', period: 'yearly' });
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

  test('a plan button clicked with a workspace leads to the purchase, not a sign-up', () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const trial = (hours: number) => ({
      plan: 'trial',
      status: 'active',
      expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    });
    expect(trialRunning(trial(120), now)).toBe(true);
    expect(trialRunning(trial(2), now)).toBe(true);
    expect(trialRunning(trial(-1), now)).toBe(false);
    expect(trialRunning({ plan: 'cloud_starter', status: 'active' }, now)).toBe(false);
    expect(trialRunning(null, now)).toBe(false);

    // Any running trial, however short: /start-trial sells it (card trial or billed today).
    expect(purchaseDestination({ role: 'ADMIN', license: trial(120), now })).toBe('/start-trial?source=pricing_signed_in');
    expect(purchaseDestination({ role: 'ADMIN', license: trial(20), now })).toBe('/start-trial?source=pricing_signed_in');
    // A paid plan is changed, never bought twice.
    expect(purchaseDestination({ role: 'ADMIN', license: { plan: 'cloud_starter', status: 'active' }, now })).toBe('/settings/license');
    // Ended: the licence wall on the dashboard sells it in place.
    expect(purchaseDestination({ role: 'ADMIN', license: trial(-1), now })).toBe('/');
    expect(purchaseDestination({ role: 'ADMIN', license: { plan: 'cloud_team', status: 'expired' }, now })).toBe('/');
    expect(purchaseDestination({ role: 'ADMIN', license: null, now })).toBe('/');
    // Only an admin can subscribe the workspace.
    expect(purchaseDestination({ role: 'EDITOR', license: trial(120), now })).toBe('/');
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

    const [starter, team] = CLOUD_PLANS;
    expect(formatPlanPrice(team, 'monthly')).toBe('49 €/month');
    expect(formatPlanPrice(starter, 'yearly')).toBe('190 €/year');
    expect(yearlyPerMonth(starter)).toBe(15.83);
    expect(yearlyPerMonth(team)).toBe(40.83);
    expect(CLOUD_PLANS.map(yearlySaving)).toEqual([38, 98]);
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
    /** GET /license/card-trial-eligibility: 'pay' = the address had a subscription. */
    eligibility?: 'trial' | 'pay' | 'none';
    /** GET /license/pricing-link-token: the address token for pricing links. */
    pricingToken?: string | null;
    /** The marketing site's /api/price-estimate for this visitor. */
    priceEstimate?: Record<string, unknown>;
    /** No session in the browser; signing in with the form starts one. */
    signedOut?: boolean;
  } = {},
) {
  const user = opts.user ?? ADMIN;
  const posted: unknown[] = [];
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  if (!opts.signedOut) await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript(
    ({ user, seed, signedOut }) => {
      if (!signedOut) {
        localStorage.setItem('amcp_token', 't');
        localStorage.setItem('amcp_user', JSON.stringify(user));
      }
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    },
    { user, seed: opts.seed ?? {}, signedOut: !!opts.signedOut },
  );
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p === '/api/price-estimate') return json(opts.priceEstimate ?? { currency: null, vat: true });
    if (p.endsWith('/auth/login') && req.method() === 'POST') return json({ accessToken: 't', user });
    if (p.endsWith('/license/checkout-link') && req.method() === 'POST') {
      const body = req.postDataJSON();
      posted.push(body);
      const reply = opts.checkout
        ? opts.checkout(body)
        : { status: 200, body: { url: 'https://checkout.example.test/start?intent=i1' } };
      return json(reply.body, reply.status);
    }
    if (p.endsWith('/license/card-trial-eligibility')) {
      return json({ kind: opts.eligibility ?? 'trial', trialEndsAt: opts.eligibility === 'trial' ? TRIAL_END : null });
    }
    if (p.endsWith('/license/pricing-link-token')) return json({ token: opts.pricingToken ?? null });
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

test.describe('local currency helpers', () => {
  test('reads the site\'s answer and rejects anything malformed', () => {
    expect(parseLocalPricing({ currency: 'USD', rate: 1.1656, vat: false })).toEqual({ currency: 'USD', rate: 1.1656, vat: false });
    expect(parseLocalPricing({ currency: null, vat: true })).toEqual({ currency: null, rate: null, vat: true });
    expect(parseLocalPricing({ currency: 'USD', rate: -1, vat: false })).toEqual({ currency: null, rate: null, vat: false });
    expect(parseLocalPricing({ currency: '<b>', rate: 1 })).toEqual({ currency: null, rate: null, vat: null });
    expect(parseLocalPricing('nonsense')).toBeNull();
  });

  test('converts like the pricing page, and stays in euros without a currency', () => {
    const usd = { currency: 'USD', rate: 1.165632, vat: false };
    expect(formatLocal(19, usd)).toBe('$22.15');
    expect(formatLocal(490, usd)).toBe('$571.16');
    expect(formatLocal(19, { currency: null, rate: null, vat: true })).toBeNull();
    expect(formatLocal(19, null)).toBeNull();
  });
});

test.describe('prices in the visitor\'s currency (cloud)', () => {
  test('a US visitor sees dollars first, the exact euro price under it, and no VAT', async ({ page }) => {
    await cloudSession(page, {
      seed: { 'amcp_card_trial_prompt:u1': 'shown' },
      priceEstimate: { currency: 'USD', rate: 1.165632, vat: false },
    });
    await page.goto('/start-trial');
    const starter = page.getByRole('radio', { name: /Starter/ });
    await expect(starter).toContainText('≈ $22.15/month', { timeout: 15_000 });
    await expect(starter).toContainText('19 €/month exactly');
    await expect(page.getByText('Prices in EUR, paid in USD at checkout.')).toBeVisible();
    await expect(page.getByText(/VAT included/)).toHaveCount(0);

    await page.getByRole('radio', { name: 'Yearly' }).click();
    await expect(page.getByRole('radio', { name: /Team/ })).toContainText('≈ $571.16/year');
    await expect(page.getByRole('radio', { name: /Team/ })).toContainText('490 €/year exactly');
  });

  test('a visitor in the euro area sees euros and VAT as before', async ({ page }) => {
    await cloudSession(page, {
      seed: { 'amcp_card_trial_prompt:u1': 'shown' },
      priceEstimate: { currency: null, vat: true },
    });
    await page.goto('/start-trial');
    await expect(page.getByRole('radio', { name: /Starter/ })).toContainText('19 €/month', { timeout: 15_000 });
    await expect(page.getByText(/≈ \$/)).toHaveCount(0);
    await expect(page.getByText('Prices in EUR, VAT included.')).toBeVisible();
  });

  test('an unreachable site leaves everything in euros', async ({ page }) => {
    await cloudSession(page, { seed: { 'amcp_card_trial_prompt:u1': 'shown' } });
    await page.route('**/api/price-estimate', (route) => route.abort());
    await page.goto('/start-trial');
    await expect(page.getByRole('radio', { name: /Starter/ })).toContainText('19 €/month', { timeout: 15_000 });
    await expect(page.getByText('Prices in EUR, VAT included.')).toBeVisible();
  });
});

test.describe('card-trial offer (cloud)', () => {
  test('a new cloud admin is offered the card trial once, and can skip it quietly', async ({ page }) => {
    await cloudSession(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/start-trial\?source=signup_prompt$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Your free trial' })).toBeVisible();
    // The real end date, never a length the user may no longer have.
    await expect(page.getByText(/^Free until \d{1,2} \w+ \d{4}$/)).toBeVisible();
    await expect(page.getByText(/7-day/)).toHaveCount(0);
    await expect(page.getByText('€0 today.')).toBeVisible();
    // Starter is preselected without an intent from the pricing page.
    await expect(page.getByRole('radio', { name: /Starter/ })).toHaveAttribute('aria-checked', 'true');

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
    await page.getByRole('radio', { name: /Team/ }).click();
    await expect(page.getByText('490 €/year')).toBeVisible();
    await page.getByRole('button', { name: 'Start free trial' }).click();

    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    // Opened without a source: the page names itself.
    expect(posted).toEqual([{ plan: 'team', billingPeriod: 'yearly', trial: true, source: 'start_trial' }]);
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
    // The register link the pricing page opens; the intent is kept whatever
    // happens next (signed in, as here, the page hands over to /start-trial).
    await page.goto('/login?mode=register&plan=cloud_team&period=yearly');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('amcp_plan_intent')), { timeout: 15_000 })
      .toContain('"plan":"team"');

    await page.goto('/start-trial');
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true');
  });

  test('offers Starter and Team, and Enterprise only as an enquiry', async ({ page }) => {
    await cloudSession(page, { seed: { 'amcp_card_trial_prompt:u1': 'shown' } });
    await page.goto('/start-trial');
    const plans = page.getByRole('radiogroup', { name: 'Plan' }).getByRole('radio');
    await expect(plans).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole('radio', { name: /Business/ })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Starter/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('link', { name: 'Ask about Enterprise' })).toHaveAttribute(
      'href',
      /\/contact\?plan=enterprise$/,
    );
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
    const cta = page.getByRole('button', { name: /Add a payment method: no charge before/ });
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();
    await expect(page).toHaveURL(/\/start-trial\?source=trial_banner$/);
    expect(posted).toEqual([]);
  });

  test('the trial banner goes straight to Checkout for the plan picked on the pricing page', async ({ page }) => {
    const intent = JSON.stringify({ plan: 'team', period: 'monthly', savedAt: Date.now() });
    const { posted } = await cloudSession(page, { seed: { ...SHOWN, amcp_plan_intent: intent } });
    await page.goto('/connectors');
    await page.getByRole('button', { name: /Add a payment method/ }).click({ timeout: 15_000 });
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'team', billingPeriod: 'monthly', trial: true, source: 'trial_banner' }]);
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
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'monthly', trial: false, source: 'trial_ended_wall' }]);
  });

  test('a non-admin keeps the plain pricing link in the banner', async ({ page }) => {
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' }, seed: SHOWN });
    await page.goto('/connectors');
    await expect(page.getByRole('link', { name: 'Upgrade now' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Add a payment method/ })).toHaveCount(0);
  });

  // The pricing page reads the buyer's address from the token and refuses a
  // second subscription beside a card trial or plan it already has.
  test('the pricing link carries the address token in its fragment', async ({ page }) => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-tok';
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' }, seed: SHOWN, pricingToken: token });
    await page.goto('/connectors');
    const link = page.getByRole('link', { name: 'Upgrade now' });
    await expect(link).toHaveAttribute('href', new RegExp(`/pricing\\?return_url=[^#]+#t=${token}$`), {
      timeout: 15_000,
    });
    // The banner names itself to the pricing page's checkout, ahead of the token.
    expect(await link.getAttribute('href')).toContain('&source=trial_banner#t=');
  });

  test('without a token the pricing link has no fragment', async ({ page }) => {
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' }, seed: SHOWN, pricingToken: null });
    await page.goto('/connectors');
    const link = page.getByRole('link', { name: 'Upgrade now' });
    await expect(link).toHaveAttribute('href', /\/pricing\?return_url=/, { timeout: 15_000 });
    expect(await link.getAttribute('href')).not.toContain('#');
  });
});

test.describe('an address that had a subscription (cloud)', () => {
  const SHOWN = { 'amcp_card_trial_prompt:u1': 'shown' };

  test('is told before checkout that the plan starts and is billed today, with its price', async ({ page }) => {
    const { posted } = await cloudSession(page, { seed: SHOWN, eligibility: 'pay' });
    await page.goto('/start-trial');
    await expect(page.getByRole('heading', { name: 'Keep your workspace running' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Your plan starts today and is billed today.')).toBeVisible();
    await expect(page.getByText(/Starter, 19\s€\/month, billed today and then every month\./)).toBeVisible();
    await expect(page.getByText('€0 today', { exact: false })).toHaveCount(0);
    await expect(page.getByText(/free trial with card/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue to checkout' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'monthly', trial: false, source: 'start_trial' }]);
  });

  test('if the licence site still refuses the trial at checkout, the page says so before sending anyone on', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      seed: SHOWN,
      checkout: () => ({ status: 200, body: { url: 'https://checkout.example.test/start?intent=i9', trial: false } }),
    });
    await page.goto('/start-trial');
    await page.getByRole('button', { name: 'Start free trial with card' }).click({ timeout: 15_000 });
    await expect(page.getByRole('status')).toContainText('the checkout will charge 19 € today');
    await expect(page).toHaveURL(/\/start-trial$/);
    await expect(page.getByText('Your plan starts today and is billed today.')).toBeVisible();

    await page.getByRole('button', { name: 'Continue to checkout' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i9');
    expect(posted).toHaveLength(1);
  });

  test('the trial banner offers "Choose a plan", not "no charge before"', async ({ page }) => {
    const intent = JSON.stringify({ plan: 'team', period: 'monthly', savedAt: Date.now() });
    const { posted } = await cloudSession(page, { seed: { ...SHOWN, amcp_plan_intent: intent }, eligibility: 'pay' });
    await page.goto('/connectors');
    const cta = page.getByRole('button', { name: 'Choose a plan' });
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/no charge before/)).toHaveCount(0);
    await cta.click();
    await expect(page).toHaveURL(/\/start-trial\?source=trial_banner$/);
    expect(posted).toEqual([]);
  });
});

/**
 * The pricing page cannot see the Cloud session, so its plan buttons always
 * open sign-up. Someone who already has a workspace is recognised there and
 * sent on to buy the plan they clicked.
 */
test.describe('a plan button clicked by someone already signed in (cloud)', () => {
  const SHOWN = { 'amcp_card_trial_prompt:u1': 'shown' };
  const REGISTER_STARTER = '/login?mode=register&plan=cloud_starter&period=monthly';

  test('a running trial goes to the card trial with the plan preselected, not to sign-up', async ({ page }) => {
    const { posted } = await cloudSession(page, { seed: SHOWN });
    await page.goto('/login?mode=register&plan=cloud_team&period=yearly');
    await expect(page).toHaveURL(/\/start-trial\?source=pricing_signed_in$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Your free trial' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Create your free account')).toHaveCount(0);

    await page.getByRole('button', { name: 'Start free trial with card' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'team', billingPeriod: 'yearly', trial: true, source: 'pricing_signed_in' }]);
  });

  test('a trial in its last 48 hours is told the plan is billed today, then checks out without a trial', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      seed: SHOWN,
      eligibility: 'none',
      license: { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(), trialDaysLeft: 1 },
    });
    await page.goto(REGISTER_STARTER);
    await expect(page).toHaveURL(/\/start-trial\?source=pricing_signed_in$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Keep your workspace running' })).toBeVisible();
    await expect(page.getByText(/too soon to carry on with a card trial/)).toBeVisible();
    await expect(page.getByText('Your plan starts today and is billed today.')).toBeVisible();
    await expect(page.getByText(/had an AnythingMCP subscription before/)).toHaveCount(0);
    await expect(page.getByText('€0 today', { exact: false })).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue to checkout' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'monthly', trial: false, source: 'pricing_signed_in' }]);
  });

  test('an ended trial lands on the licence wall with the clicked plan preselected', async ({ page }) => {
    await cloudSession(page, {
      seed: SHOWN,
      license: { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() - 86_400_000).toISOString(), trialDaysLeft: 0 },
    });
    await page.goto('/login?mode=register&plan=cloud_team&period=monthly');
    await expect(page.getByRole('heading', { name: 'Your Trial Has Expired' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('a paid plan goes to Settings → License, never to a second checkout', async ({ page }) => {
    const { posted } = await cloudSession(page, {
      seed: SHOWN,
      license: { plan: 'cloud_starter', status: 'active', expiresAt: null, features: {} },
    });
    await page.goto(REGISTER_STARTER);
    await expect(page).toHaveURL(/\/settings\/license$/, { timeout: 15_000 });
    await expect(page.getByText('You already have a plan', { exact: true })).toBeVisible();
    expect(posted).toEqual([]);
  });

  test('a non-admin is sent to the dashboard and told to ask an admin', async ({ page }) => {
    await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' }, seed: SHOWN });
    await page.goto(REGISTER_STARTER);
    await expect(page.getByText('Ask a workspace admin', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/(login|start-trial)/);
  });

  test('signed out in this browser, signing in from the sign-up link leads to the purchase too', async ({ page }) => {
    await cloudSession(page, { seed: SHOWN, signedOut: true });
    await page.goto('/login?mode=login&plan=cloud_starter&period=monthly');
    await page.getByPlaceholder('admin@example.com').fill('admin@example.test');
    await page.getByPlaceholder('Min. 8 characters').fill('Secret-123');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page).toHaveURL(/\/start-trial\?source=pricing_signed_in$/, { timeout: 15_000 });
    await expect(page.getByRole('radio', { name: /Starter/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('without a plan in the link, the sign-up page is left alone', async ({ page }) => {
    await cloudSession(page, { seed: SHOWN });
    await page.goto('/login?mode=register');
    await expect(page.getByText('Create your free account')).toBeVisible({ timeout: 15_000 });
  });
});
