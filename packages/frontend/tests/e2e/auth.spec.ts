import { expect, test } from '@playwright/test';

/**
 * Minimal e2e for the auth flow + the new error/not-found pages.
 *
 * Aims to catch regressions on the things Sprint 2 actually changed:
 *   - login renders and the form has the new label/input pairing
 *   - 404 → branded not-found.tsx (not Next's default)
 *
 * Doesn't try to log in for real — that needs a backend. Anything backend-
 * dependent is covered by scripts/smoke-test/run.sh.
 */

test.describe('auth UI', () => {
  test('login page renders with accessible labels and label/input pairing', async ({
    page,
  }) => {
    await page.goto('/login');
    const email = page.locator('#auth-email');
    const password = page.locator('#auth-password');
    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    // Clicking the visible label focuses the matching input — proves htmlFor works.
    await page.locator('label[for="auth-email"]').click();
    await expect(email).toBeFocused();
  });

  test('forgot-password label/input pairing works', async ({ page }) => {
    await page.goto('/forgot-password');
    const email = page.locator('#forgot-email');
    await expect(email).toBeVisible();
    await page.locator('label[for="forgot-email"]').click();
    await expect(email).toBeFocused();
    await email.fill('user@example.com');
    await expect(email).toHaveValue('user@example.com');
  });

  test('unknown route shows the branded 404', async ({ page }) => {
    // /login/* is allowed by the auth proxy, so the request reaches Next
    // (otherwise the proxy would redirect us back to /login with no 404).
    const res = await page.goto('/login/this-route-does-not-exist');
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: /page not found/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /go to dashboard/i }),
    ).toBeVisible();
  });
});
