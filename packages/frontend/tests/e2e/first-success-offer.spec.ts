import { expect, test, type Page } from '@playwright/test';
import {
  OFFER_DISMISS_MS,
  isOfferDismissed,
  offerDay,
  offerDetail,
  offerHeadline,
  parseCheckoutSource,
  shouldReportShown,
} from '../../src/lib/first-success-offer';

/**
 * The card-trial offer right after a Cloud workspace's first successful tool
 * call: a dismissible card for admins on the dashboard, the connector list and
 * the connect page, leading to /start-trial?source=first_success, whose
 * checkout carries the source to Stripe.
 *
 * Helpers first (no browser); then the same fake session as card-trial.spec.ts.
 */

test.describe('first-success offer helpers', () => {
  test('accepts only known checkout sources', () => {
    expect(parseCheckoutSource('first_success')).toBe('first_success');
    expect(parseCheckoutSource(' first_success ')).toBe('first_success');
    expect(parseCheckoutSource('newsletter')).toBeNull();
    expect(parseCheckoutSource('')).toBeNull();
    expect(parseCheckoutSource(null)).toBeNull();
  });

  test('a dismissal hides the offer for three days', () => {
    const now = Date.UTC(2026, 9, 13, 12);
    expect(isOfferDismissed(String(now - 60_000), now)).toBe(true);
    expect(isOfferDismissed(String(now - OFFER_DISMISS_MS + 1), now)).toBe(true);
    expect(isOfferDismissed(String(now - OFFER_DISMISS_MS), now)).toBe(false);
    expect(isOfferDismissed(null, now)).toBe(false);
    expect(isOfferDismissed('garbage', now)).toBe(false);
    // A clock set back never hides it for good.
    expect(isOfferDismissed(String(now + 86_400_000), now)).toBe(false);
  });

  test('"shown" is reported once a day', () => {
    const now = Date.UTC(2026, 9, 13, 23, 59);
    expect(shouldReportShown(null, now)).toBe(true);
    expect(shouldReportShown(offerDay(now), now)).toBe(false);
    expect(shouldReportShown(offerDay(now), now + 2 * 60_000)).toBe(true);
  });

  test('names the connector and the trial end, without long dashes', () => {
    expect(offerHeadline('Shopify')).toBe('Your AI just ran its first Shopify action.');
    expect(offerHeadline(null)).toBe('Your AI just ran its first action.');
    const detail = offerDetail('Shopify', '18 October 2026');
    expect(detail).toBe(
      'Keep it running: start your trial, and Shopify keeps working after your free trial ends on 18 October 2026.',
    );
    for (const text of [detail, offerDetail(null, null), offerHeadline('x')]) {
      expect(text).not.toMatch(/[—–]/);
      // The card trial ends with the free trial: no length is promised.
      expect(text).not.toMatch(/7-day/);
    }
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
const OFFER = { connectorName: 'My Shopify store', trialEndsAt: TRIAL_END };

async function cloudSession(
  page: Page,
  opts: {
    user?: typeof ADMIN;
    mode?: 'cloud' | 'self-hosted';
    offer?: typeof OFFER | null;
    seed?: Record<string, string>;
  } = {},
) {
  const user = opts.user ?? ADMIN;
  const events: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const checkouts: unknown[] = [];
  let offerCalls = 0;
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript(
    ({ user, seed }) => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify(user));
      // Past the sign-up card-trial prompt: these tests are about the later offer.
      localStorage.setItem(`amcp_card_trial_prompt:${user.id}`, 'skipped');
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
      return json({
        deploymentMode: opts.mode ?? 'cloud',
        mcpAuthMode: 'oauth2',
        hasUsers: true,
        registrationEnabled: true,
        ssoProviders: [],
      });
    }
    if (p.endsWith('/license/card-trial-offer')) {
      offerCalls++;
      return json({ offer: opts.offer === undefined ? OFFER : opts.offer });
    }
    if (p.endsWith('/product-events') && req.method() === 'POST') {
      events.push(req.postDataJSON());
      return route.fulfill({ status: 204, body: '' });
    }
    if (p.endsWith('/license/checkout-link') && req.method() === 'POST') {
      checkouts.push(req.postDataJSON());
      return json({ url: 'https://checkout.example.test/start?intent=i1' });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-10-12T09:00:00.000Z' });
    if (p.endsWith('/users/me')) return json(user);
    if (p.endsWith('/license/status')) {
      return json({ plan: 'trial', status: 'active', expiresAt: TRIAL_END, trialDaysLeft: 5, features: {} });
    }
    if (p.endsWith('/license/usage')) {
      return json({
        plan: 'trial',
        connectors: { current: 1, max: 2, isOver: false },
        mcpServers: { current: 1, max: 2, isOver: false },
        users: { current: 1, max: 1, isOver: false },
        isOverAny: false,
      });
    }
    if (p.endsWith('/audit/stats')) return json({ invocations24h: 1, errors24h: 0, invocations7d: 1, totalInvocations: 1 });
    if (p.endsWith('/connectors') || p.endsWith('/adapters') || p.endsWith('/mcp-servers')) return json([]);
    return json({});
  });
  await page.route('https://checkout.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe Checkout stub</h1>' }),
  );
  return { events, checkouts, offerCalls: () => offerCalls };
}

const offerCard = (page: Page) => page.getByTestId('first-success-offer');

test.describe('first-success offer (cloud)', () => {
  test('an admin sees it on the dashboard and goes to the card trial with the source', async ({ page }) => {
    const { events, checkouts } = await cloudSession(page);
    await page.goto('/');
    await expect(offerCard(page)).toBeVisible({ timeout: 15_000 });
    await expect(offerCard(page)).toContainText('Your AI just ran its first My Shopify store action.');
    await expect(offerCard(page)).toContainText('Keep it running: start your trial, and My Shopify store keeps working');

    await page.getByRole('button', { name: 'Start your trial' }).click();
    await expect(page).toHaveURL(/\/start-trial\?source=first_success$/, { timeout: 15_000 });
    expect(events.map((e) => e.event)).toEqual(['card_trial_offer_shown', 'card_trial_offer_clicked']);
    expect(events[0].metadata).toEqual({ via: 'dashboard' });

    await page.getByRole('button', { name: 'Start free trial' }).click();
    await expect(page).toHaveURL('https://checkout.example.test/start?intent=i1');
    expect(checkouts).toEqual([{ plan: 'starter', billingPeriod: 'monthly', trial: true, source: 'first_success' }]);
  });

  test('"shown" is reported once a day, not on every page', async ({ page }) => {
    const { events } = await cloudSession(page);
    await page.goto('/');
    await expect(offerCard(page)).toBeVisible({ timeout: 15_000 });
    await page.goto('/connectors');
    await expect(offerCard(page)).toBeVisible({ timeout: 15_000 });
    expect(events.filter((e) => e.event === 'card_trial_offer_shown')).toHaveLength(1);
  });

  test('"Not now" hides it on every page for days, without asking the server again', async ({ page }) => {
    const session = await cloudSession(page);
    await page.goto('/connectors');
    await expect(offerCard(page)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(offerCard(page)).toHaveCount(0);
    expect(session.events.map((e) => e.event)).toContain('card_trial_offer_dismissed');
    expect(session.events.find((e) => e.event === 'card_trial_offer_dismissed')?.metadata).toEqual({ via: 'connectors' });

    const calls = session.offerCalls();
    await page.goto('/');
    await expect(page.getByText('Active connectors')).toBeVisible({ timeout: 15_000 });
    await expect(offerCard(page)).toHaveCount(0);
    expect(session.offerCalls()).toBe(calls);
  });

  test('one call to action at a time: the trial banner drops its payment link while the card is up', async ({ page }) => {
    await cloudSession(page);
    await page.goto('/connectors');
    await expect(offerCard(page)).toBeVisible({ timeout: 15_000 });
    // The banner keeps its countdown, without its own link.
    await expect(page.getByText('Trial: 5 days left.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add a payment method/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(offerCard(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add a payment method/ })).toBeVisible();
  });

  test('without the card, the banner keeps its payment link', async ({ page }) => {
    await cloudSession(page, { offer: null });
    await page.goto('/connectors');
    await expect(page.getByRole('button', { name: /Add a payment method/ })).toBeVisible({ timeout: 15_000 });
  });

  test('is never shown to a member who is not an admin', async ({ page }) => {
    const session = await cloudSession(page, { user: { ...ADMIN, role: 'EDITOR' } });
    await page.goto('/');
    await expect(page.getByText('Active connectors')).toBeVisible({ timeout: 15_000 });
    await expect(offerCard(page)).toHaveCount(0);
    expect(session.offerCalls()).toBe(0);
  });

  test('shows nothing when the workspace is not eligible', async ({ page }) => {
    const session = await cloudSession(page, { offer: null });
    await page.goto('/');
    await expect(page.getByText('Active connectors')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => session.offerCalls()).toBeGreaterThan(0);
    await expect(offerCard(page)).toHaveCount(0);
    expect(session.events).toEqual([]);
  });
});

test.describe('first-success offer (self-hosted)', () => {
  test('never appears and never asks', async ({ page }) => {
    const session = await cloudSession(page, { mode: 'self-hosted' });
    await page.goto('/');
    await expect(page.getByText('Active connectors')).toBeVisible({ timeout: 15_000 });
    await expect(offerCard(page)).toHaveCount(0);
    expect(session.offerCalls()).toBe(0);
  });
});
