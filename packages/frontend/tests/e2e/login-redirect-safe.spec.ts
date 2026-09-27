import { expect, test } from '@playwright/test';

/**
 * `?redirect=` is attacker-controlled. After sign-in the login page must only
 * follow same-origin paths, or /login?redirect=https://evil becomes a phishing
 * launcher on our domain. Driven through the SSO code exchange, which signs in
 * and redirects without a real backend.
 */
const USER = { id: 'u1', email: 'a@example.test', name: 'A', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

async function signInVia(page: import('@playwright/test').Page, redirect: string) {
  await page.route(/\/(api|health)\//, (route) => {
    const p = new URL(route.request().url()).pathname;
    const body = p.endsWith('/auth/sso/exchange') ? { accessToken: 't', user: USER } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`/login?sso=abc&redirect=${encodeURIComponent(redirect)}`);
}

for (const evil of ['https://evil.example/phish', '//evil.example/phish', '/\\evil.example/phish', '/\t/evil.example']) {
  test(`does not follow an off-site redirect: ${JSON.stringify(evil)}`, async ({ page }) => {
    await signInVia(page, evil);
    await page.waitForURL((u) => u.pathname !== '/login', { timeout: 15_000 });
    expect(new URL(page.url()).host).toBe(new URL(page.context().pages()[0].url()).host);
    expect(page.url()).not.toContain('evil.example');
  });
}

test('follows a same-origin redirect with its query string', async ({ page }) => {
  await signInVia(page, '/connectors/store?install=weclapp');
  await page.waitForURL(/\/connectors\/store\?install=weclapp$/, { timeout: 15_000 });
});
