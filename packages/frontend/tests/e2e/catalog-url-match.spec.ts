import { expect, test } from '@playwright/test';

/**
 * People kept building by hand connectors the catalog already had (Printify,
 * Fatture in Cloud, Pinterest…). Typing a base URL the catalog knows in the
 * custom connector form offers the ready-made connector.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

test('a known base URL offers the catalog connector', async ({ page, baseURL }) => {
  const asked: string[] = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: baseURL! }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/api/adapters/match-url')) {
      const typed = new URL(url).searchParams.get('url') ?? '';
      asked.push(typed);
      return json({
        matches: typed.includes('printify.com')
          ? [{ slug: 'printify', name: 'Printify', icon: 'printify', description: 'Print on demand.', toolCount: 24 }]
          : [],
      });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    return json({});
  });

  await page.goto('/connectors/new');
  await page.getByRole('button', { name: /REST API/ }).click();
  const baseUrl = page.getByPlaceholder('https://api.example.com/v1');
  await expect(baseUrl).toBeVisible({ timeout: 15_000 });

  await baseUrl.fill('https://api.unknown.dev');
  await expect.poll(() => asked.at(-1)).toBe('https://api.unknown.dev');
  await expect(page.getByTestId('catalog-url-match')).toHaveCount(0);

  await baseUrl.fill('https://api.printify.com/v1');
  const offer = page.getByTestId('catalog-url-match');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('There is a ready-made connector for this API');
  await expect(offer.getByRole('link', { name: /Printify/ })).toHaveAttribute('href', '/connectors/setup/printify');
  await expect(offer).toContainText('24 tools');
});
