import { expect, test, type Page } from '@playwright/test';

/**
 * Cloud: an account created from an invitation starts with an unverified
 * address and is asked for its email code, in the same step a password
 * sign-up uses. Self-hosted accounts go straight in, as before. The backend
 * is mocked (see playwright.config.ts).
 */

const info = (deploymentMode: 'cloud' | 'self-hosted') => ({
  deploymentMode,
  mcpAuthMode: 'oauth2',
  hasUsers: true,
  registrationEnabled: false,
  ssoProviders: [],
});

const INVITEE = { id: 'u9', email: 'invitee@example.test', name: 'Ivy', role: 'EDITOR', organizationId: 'o1' };

async function mockBackend(page: Page, mode: 'cloud' | 'self-hosted', calls: string[]) {
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    calls.push(p);
    if (p === '/health/server-info') return route.fulfill({ json: info(mode) });
    if (p === '/api/auth/invite/verify') {
      return route.fulfill({ json: { email: INVITEE.email, role: 'EDITOR', valid: true, exists: false, ssoOnly: false } });
    }
    if (p === '/api/auth/accept-invite') {
      return route.fulfill({
        status: 201,
        json:
          mode === 'cloud'
            ? { accessToken: 't', user: { ...INVITEE, emailVerified: false }, verificationRequired: true }
            : { accessToken: 't', user: { ...INVITEE, emailVerified: true } },
      });
    }
    if (p === '/api/auth/verify-email') return route.fulfill({ json: { message: 'ok', emailVerified: true } });
    if (p === '/api/users/me') return route.fulfill({ json: { ...INVITEE, emailVerified: true } });
    return route.fulfill({ json: {} });
  });
}

async function createAccount(page: Page) {
  await page.goto('/accept-invite?token=abc123');
  await expect(page.getByRole('heading', { name: 'Accept Invitation' })).toBeVisible();
  await page.getByPlaceholder('Full name').fill('Ivy');
  await page.getByPlaceholder('Min. 8 characters').fill('Str0ng#Passw0rd');
  await page.getByPlaceholder('Repeat password').fill('Str0ng#Passw0rd');
  await page.getByRole('button', { name: 'Create Account' }).click();
}

test('cloud: a new invited account enters its email code, then joins without a trial step', async ({ page }) => {
  const calls: string[] = [];
  await mockBackend(page, 'cloud', calls);
  await createAccount(page);

  await expect(page).toHaveURL(/\/login\?verify=invite$/);
  await expect(page.getByRole('heading', { name: 'Verify Your Email' })).toBeVisible();
  await expect(page.getByText(INVITEE.email)).toBeVisible();
  // The session was handed over once, and never through the URL.
  expect(await page.evaluate(() => sessionStorage.getItem('amcp_invite_email_code'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBeNull();

  await page.locator('input[inputmode="numeric"]').fill('123456');
  await page.getByRole('button', { name: 'Verify Email' }).click();

  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  expect(calls).toContain('/api/auth/verify-email');
  expect(calls).not.toContain('/api/license/activate-trial');
});

test('self-hosted: a new invited account goes straight in, with no code step', async ({ page }) => {
  const calls: string[] = [];
  await mockBackend(page, 'self-hosted', calls);
  await createAccount(page);

  await expect(page).not.toHaveURL(/\/(accept-invite|login)/, { timeout: 15_000 });
  expect(calls).not.toContain('/api/auth/verify-email');
});
