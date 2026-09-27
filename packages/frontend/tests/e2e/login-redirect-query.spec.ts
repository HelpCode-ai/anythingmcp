import { expect, test } from '@playwright/test';

/**
 * Install links (/connectors/store?install=<slug>) are published in READMEs,
 * guides and satellite repositories, so most people open them signed out.
 * The sign-in redirect used to carry only the pathname, and the adapter to
 * install was lost on the way through /login.
 */
test('a signed-out install link keeps its query string through /login', async ({ page }) => {
  await page.route(/\/(api|health)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/connectors/store?install=weclapp');
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/connectors/store?install=weclapp');
});
