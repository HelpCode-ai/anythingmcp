import { expect, test, type Page } from '@playwright/test';

/**
 * Sign-up from "Connect" in Claude: after verifying the email, a new admin on
 * a fresh free trial is offered the card trial once, then always returns to
 * the pending authorization (/auth/login, served by the backend), whichever
 * way they leave the offer:
 *   - "Continue without payment details" → back to approve;
 *   - a completed checkout → the licence site returns to
 *     /settings/license/activate#key=…, which activates and goes back;
 *   - a cancelled checkout → Stripe returns to /start-trial, skip → back.
 * The authorization must never be stranded, which is what an earlier version
 * of the trial offer did in this flow.
 */

const CLOUD_INFO = { deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] };
const NEUTRAL = { verificationRequired: true, message: 'Check your inbox.' };
const TRIAL_END = new Date(Date.now() + 7 * 86_400_000).toISOString();
const KEY = 'AMCP-AB12-CD34-EF56-0789';

interface Calls {
  paths: string[];
  checkout: unknown[];
  setKey: unknown[];
}

async function mockCloud(page: Page, opts: { role?: string; license?: Record<string, unknown> } = {}): Promise<Calls> {
  const calls: Calls = { paths: [], checkout: [], setKey: [] };
  const user = { id: 'u-claude', email: 'claude@example.test', name: 'Jane', role: opts.role ?? 'ADMIN', organizationId: 'o1' };
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    calls.paths.push(p);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/health/server-info') return json(CLOUD_INFO);
    if (p === '/api/auth/register') return json(NEUTRAL, 201);
    if (p === '/api/auth/login') return json({ accessToken: 't', user: { ...user, emailVerified: false }, needsLicenseSetup: true });
    if (p === '/api/auth/verify-email') return json({ message: 'ok', emailVerified: true });
    if (p === '/api/license/status') {
      return json(opts.license ?? { plan: 'trial', status: 'active', expiresAt: TRIAL_END, trialDaysLeft: 7, features: {} });
    }
    if (p === '/api/license/checkout-link') {
      calls.checkout.push(req.postDataJSON());
      return json({ url: 'https://checkout.example.test/start?intent=i1' });
    }
    if (p === '/api/license/key' || p === '/api/license/activate') {
      calls.setKey.push(req.postDataJSON());
      return json({ message: 'License activated successfully.' });
    }
    if (p.endsWith('/users/me')) return json({ ...user, emailVerified: true });
    return json({});
  });
  // The backend's authorization page and Stripe Checkout, stubbed.
  await page.route((url) => url.pathname === '/auth/login', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Authorize AnythingMCP</h1>' }),
  );
  await page.route('https://checkout.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe Checkout</h1>' }),
  );
  return calls;
}

async function signUpFromClaude(page: Page) {
  await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin');
  await page.locator('#auth-name').fill('Jane');
  await page.locator('#auth-email').fill('claude@example.test');
  await page.locator('#auth-password').fill('Str0ng#Passw0rd');
  await page.locator('#auth-confirm-password').fill('Str0ng#Passw0rd');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
  await page.locator('input[autocomplete="one-time-code"]').fill('123456');
  await page.getByRole('button', { name: 'Verify Email' }).click();
}

test.describe('card trial when signing up from Claude', () => {
  test('is offered once after verifying, and skipping goes back to approve', async ({ page }) => {
    const calls = await mockCloud(page);
    await signUpFromClaude(page);

    await expect(page).toHaveURL(/\/start-trial$/, { timeout: 15_000 });
    await expect(page.getByText('you go straight back to finish connecting your AI client')).toBeVisible();
    await page.getByRole('button', { name: 'Try free without payment details' }).click();

    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Authorize AnythingMCP' })).toBeVisible();
    expect(calls.checkout).toHaveLength(0);
    // The way back is spent: a later visit to /start-trial does not detour again.
    expect(await page.evaluate(() => localStorage.getItem('amcp_card_trial_return'))).toBeNull();
  });

  test('a completed checkout activates the licence and goes back to approve', async ({ page }) => {
    const calls = await mockCloud(page);
    await signUpFromClaude(page);
    await expect(page).toHaveURL(/\/start-trial$/, { timeout: 15_000 });

    await page.getByRole('button', { name: 'Start free trial with card' }).click();
    await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible();
    expect(calls.checkout).toEqual([expect.objectContaining({ trial: true })]);

    // The licence site's success page hands the key over in the fragment.
    await page.goto(`/settings/license/activate#key=${KEY}`);
    await expect(page.getByText('Taking you back to finish connecting your AI client')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    expect(JSON.stringify(calls.setKey)).toContain(KEY);
  });

  test('a cancelled checkout comes back to the offer, and skipping still goes back to approve', async ({ page }) => {
    await mockCloud(page);
    await signUpFromClaude(page);
    await expect(page).toHaveURL(/\/start-trial$/, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Start free trial with card' }).click();
    await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible();

    // Stripe's cancel URL for a card trial.
    await page.goto('/start-trial');
    await page.getByRole('button', { name: 'Continue without payment details' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
  });

  test('a member who cannot subscribe goes straight back to approve', async ({ page }) => {
    const calls = await mockCloud(page, { role: 'EDITOR' });
    await signUpFromClaude(page);
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    expect(calls.paths).not.toContain('/api/license/checkout-link');
  });

  test('without a running trial to convert, goes straight back to approve', async ({ page }) => {
    await mockCloud(page, { license: { plan: 'cloud_team', status: 'active', expiresAt: TRIAL_END } });
    await signUpFromClaude(page);
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
  });

  test('an expired way back is not followed', async ({ page }) => {
    // A stale entry (older than the 30 minutes the backend keeps an
    // authorization) must not send a later visitor to a dead consent page.
    await mockCloud(page);
    await page.context().addCookies([{ name: 'amcp_token', value: 't', url: test.info().project.use.baseURL ?? 'http://localhost:3100' }]);
    await page.addInitScript(() => {
      localStorage.setItem('amcp_token', 't');
      localStorage.setItem('amcp_user', JSON.stringify({ id: 'u-claude', email: 'claude@example.test', role: 'ADMIN', organizationId: 'o1', emailVerified: true }));
      localStorage.setItem('amcp_card_trial_return', JSON.stringify({ path: '/auth/login', savedAt: Date.now() - 31 * 60 * 1000 }));
    });
    await page.goto('/start-trial');
    await expect(page.getByText('you go straight back to finish connecting your AI client')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue without payment details' }).click();
    await expect(page).not.toHaveURL(/\/auth\/login/);
  });
});
