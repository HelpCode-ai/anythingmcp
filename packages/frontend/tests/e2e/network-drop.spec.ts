import { expect, test, type Page } from '@playwright/test';
import { isNetworkError } from '../../src/lib/network-error';

/**
 * A request that gets no answer is not a rejected session.
 *
 * ANYTHINGMCP-CLOUD-FRONTEND-7: a Mac woke from sleep before its network was
 * back, the session check (/api/users/me) failed with Safari's "Load failed",
 * and the app treated that as an expired token: it deleted the saved session
 * and sent the user to /login, offline, where the page broke. Only an answer
 * from the backend that rejects the session may sign someone out.
 */

const USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function savedSession(page: Page, me: 'network-error' | 'server-error' | 'unauthorized') {
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    // Only on the first load: the sign-out path clears these on purpose.
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'none', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) {
      if (me === 'network-error') return route.abort('internetdisconnected');
      if (me === 'server-error') return json({ message: 'Bad Gateway' }, 502);
      return json({ message: 'Unauthorized' }, 401);
    }
    if (p.endsWith('/license/status')) return json({ plan: 'business', status: 'active', features: {} });
    return json([]);
  });
}

test.describe('session check without an answer', () => {
  test('keeps the session when /users/me gets no answer', async ({ page }) => {
    await savedSession(page, 'network-error');
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).not.toBe('/login');
    expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBe('t');
  });

  test('keeps the session when the backend answers 502 during a deploy', async ({ page }) => {
    await savedSession(page, 'server-error');
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).not.toBe('/login');
    expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBe('t');
  });

  test('still signs out when the backend rejects the token', async ({ page }) => {
    await savedSession(page, 'unauthorized');
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBeNull();
  });
});

test.describe('isNetworkError', () => {
  test('recognises what each browser says when a request gets no answer', () => {
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isNetworkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkError(new Error('Load failed because of X'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});
