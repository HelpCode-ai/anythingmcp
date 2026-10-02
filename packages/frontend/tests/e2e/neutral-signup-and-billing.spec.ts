import { expect, test, type Page } from '@playwright/test';

/**
 * Cloud sign-up answers the same whether or not the address already has an
 * account, and "manage plan" links no longer carry the user's email address.
 * The backend is mocked (see playwright.config.ts): these pin what the UI does
 * with each answer.
 */

const CLOUD_INFO = {
  deploymentMode: 'cloud',
  mcpAuthMode: 'oauth2',
  hasUsers: true,
  registrationEnabled: true,
  ssoProviders: [],
};

const NEUTRAL = { verificationRequired: true, message: 'Check your inbox.' };

async function fillSignup(page: Page, email: string, query = '') {
  await page.goto(`/login?mode=register${query}`);
  await expect(page.locator('#auth-name')).toBeVisible();
  await page.locator('#auth-name').fill('Jane');
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill('Str0ng#Passw0rd');
  await page.locator('#auth-confirm-password').fill('Str0ng#Passw0rd');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create Account' }).click();
}

test.describe('cloud sign-up', () => {
  test('an address that cannot be signed in to gets the neutral "check your inbox" screen', async ({ page }) => {
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/health/server-info') return route.fulfill({ json: CLOUD_INFO });
      if (p === '/api/auth/register') return route.fulfill({ status: 201, json: NEUTRAL });
      if (p === '/api/auth/login') {
        return route.fulfill({
          status: 401,
          json: { statusCode: 401, message: 'Invalid email or password' },
        });
      }
      return route.fulfill({ json: {} });
    });

    await fillSignup(page, 'taken@example.test');
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByText('taken@example.test')).toBeVisible();
    // No error that would tell an address with an account from one without.
    await expect(page.getByText(/already registered|invalid email or password/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });

  test('a new address signs in with what was just entered and lands on the code screen', async ({ page }) => {
    const calls: string[] = [];
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      calls.push(p);
      if (p === '/health/server-info') return route.fulfill({ json: CLOUD_INFO });
      if (p === '/api/auth/register') return route.fulfill({ status: 201, json: NEUTRAL });
      if (p === '/api/auth/login') {
        return route.fulfill({
          json: {
            accessToken: 't',
            user: { id: 'u1', email: 'new@example.test', name: 'Jane', role: 'ADMIN', organizationId: 'o1', emailVerified: false },
            needsLicenseSetup: true,
          },
        });
      }
      return route.fulfill({ json: {} });
    });

    await fillSignup(page, 'new@example.test');
    await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
    await expect(page.getByText('new@example.test')).toBeVisible();
    expect(calls.filter((c) => c.startsWith('/api/auth/'))).toEqual(['/api/auth/register', '/api/auth/login']);
  });
});

test.describe('sign-up from an AI client (Claude "Connect")', () => {
  // The MCP authorization page links "Create an account" with
  // redirect=/auth/login. After verifying, the new user must land back on that
  // page (still inside the pending authorization) to approve with one click,
  // not on the trial offer or the welcome wizard, which used to strand the
  // connection half way.
  test('after verifying the email, goes straight back to the authorization page', async ({ page }) => {
    const calls: string[] = [];
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      calls.push(p);
      if (p === '/health/server-info') return route.fulfill({ json: CLOUD_INFO });
      if (p === '/api/auth/register') return route.fulfill({ status: 201, json: NEUTRAL });
      if (p === '/api/auth/login') {
        return route.fulfill({
          json: {
            accessToken: 't',
            user: { id: 'u1', email: 'claude@example.test', name: 'Jane', role: 'ADMIN', organizationId: 'o1', emailVerified: false },
            needsLicenseSetup: true,
          },
        });
      }
      if (p === '/api/auth/verify-email') return route.fulfill({ json: { message: 'ok', emailVerified: true } });
      if (p === '/api/license/activate-trial') {
        return route.fulfill({ json: { trialStarted: false, trialDaysLeft: 7, plan: 'trial', expiresAt: null, licenseKey: 'k', message: '' } });
      }
      return route.fulfill({ json: {} });
    });
    // The backend-served authorization page, stubbed.
    await page.route((url) => url.pathname === '/auth/login', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Authorize AnythingMCP</h1>' }),
    );

    await fillSignup(page, 'claude@example.test', '&redirect=%2Fauth%2Flogin');
    await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
    await page.locator('input[inputmode="numeric"]').fill('123456');
    await page.getByRole('button', { name: 'Verify Email' }).click();

    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Authorize AnythingMCP' })).toBeVisible();
    expect(calls).toContain('/api/auth/verify-email');
    // Not detoured through the trial offer or the welcome wizard.
    expect(calls.some((c) => c.includes('checkout-link'))).toBe(false);
  });

  test('an off-site redirect is ignored', async ({ page }) => {
    await page.route(/\/(api|health)\//, (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/health/server-info') return route.fulfill({ json: CLOUD_INFO });
      return route.fulfill({ json: {} });
    });
    await page.goto('/login?mode=register&redirect=https%3A%2F%2Fevil.example%2Fauth%2Flogin');
    await expect(page.locator('#auth-name')).toBeVisible();
  });
});

const ADMIN = {
  id: 'u1',
  email: 'owner@example.test',
  name: 'Owner',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function signedIn(page: Page, user: typeof ADMIN, portal: () => Promise<object | null>) {
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: 'http://localhost:3100' }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/health/server-info') return route.fulfill({ json: { ...CLOUD_INFO } });
    if (p.endsWith('/users/me')) return route.fulfill({ json: user });
    if (p.endsWith('/license/status')) {
      return route.fulfill({
        json: { plan: 'team', status: 'active', features: {}, expiresAt: null, lastVerifiedAt: null, instanceId: 'i' },
      });
    }
    if (p.endsWith('/license/billing-portal')) {
      const body = await portal();
      return body
        ? route.fulfill({ json: body })
        : route.fulfill({ status: 400, json: { statusCode: 400, message: 'No portal' } });
    }
    return route.fulfill({ json: {} });
  });
  // Stand-ins for Stripe and the marketing site, so navigation can be observed.
  await page.route('https://billing.stripe.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>stripe portal</h1>' }),
  );
  await page.route('https://anythingmcp.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>account page</h1>' }),
  );
}

test.describe('manage plan', () => {
  test('the link carries no email address, and an admin goes straight to the billing portal', async ({ page }) => {
    await signedIn(page, ADMIN, async () => ({ url: 'https://billing.stripe.test/session/abc' }));
    await page.goto('/settings/license');

    const link = page.getByRole('link', { name: 'change it in the billing portal' });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href')) ?? '';
    expect(href).toMatch(/\/account$/);
    expect(href).not.toContain('email');
    expect(href).not.toContain('owner%40example.test');

    await link.click();
    await expect(page).toHaveURL('https://billing.stripe.test/session/abc');
  });

  test('when the portal cannot be opened, the admin still reaches /account — without their address', async ({ page }) => {
    await signedIn(page, ADMIN, async () => null);
    await page.goto('/settings/license');
    await page.getByRole('link', { name: 'change it in the billing portal' }).click();
    await expect(page).toHaveURL('https://anythingmcp.com/account');
  });
});
