import { expect, test, type Page } from '@playwright/test';

/**
 * Per-tool rate limits on an MCP role (Settings → Roles → Manage tools).
 * Limits were only reachable through the API; an admin could neither see
 * nor set them in the dashboard.
 */

const USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

type Put = { url: string; body: unknown };

async function openRoles(page: Page) {
  const puts: Put[] = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (req.method() === 'PUT') {
      puts.push({ url: url.pathname, body: req.postDataJSON() });
      return json({ message: 'ok' });
    }
    if (url.pathname === '/api/roles') {
      return json([
        { id: 'r1', name: 'Sales', description: null, isSystem: false, _count: { users: 2, toolAccess: 1 } },
      ]);
    }
    if (url.pathname === '/api/roles/r1/tools') {
      return json([
        { id: 'g1', roleId: 'r1', toolId: 't1', callsPerMinute: 10, callsPerHour: null, tool: { id: 't1', name: 'erp_query', connector: { id: 'c1', name: 'ERP' } } },
      ]);
    }
    if (url.pathname === '/api/connectors/c1/tools') {
      return json([{ id: 't1', name: 'erp_query' }, { id: 't2', name: 'erp_export' }]);
    }
    if (url.pathname === '/api/connectors') return json([{ id: 'c1', name: 'ERP', type: 'REST' }]);
    if (url.pathname === '/api/users') return json([]);
    if (url.pathname.startsWith('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.pathname === '/api/users/me') return json(USER);
    if (url.pathname === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.pathname === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.pathname === '/api/license/status') return json({ plan: 'team', status: 'active' });
    return json({});
  });

  await page.goto('/settings/roles');
  await page.getByRole('button', { name: 'Manage tools' }).click();
  await expect(page.getByTestId('rate-limit-hint')).toBeVisible();
  return puts;
}

test.describe('role tool rate limits', () => {
  test('shows the saved limit and saves new and cleared limits', async ({ page }) => {
    const puts = await openRoles(page);

    const minute = page.getByLabel('Calls per minute for erp_query');
    await expect(minute).toHaveValue('10');
    await expect(page.getByText('1 limited')).toBeVisible();
    // An unticked tool has no limit fields.
    await expect(page.getByTestId('rate-limit-erp_export')).toHaveCount(0);

    await page.getByText('erp_export').click();
    await page.getByLabel('Calls per hour for erp_export').fill('200');
    await minute.fill('');

    await page.getByRole('button', { name: /Save \(2 tools\)/ }).click();
    await expect.poll(() => puts.length).toBe(3);

    expect(puts[0]).toEqual({ url: '/api/roles/r1/tools', body: { toolIds: ['t1', 't2'] } });
    expect(puts.slice(1)).toEqual(
      expect.arrayContaining([
        { url: '/api/roles/r1/tools/t1/rate-limit', body: { callsPerMinute: null, callsPerHour: null } },
        { url: '/api/roles/r1/tools/t2/rate-limit', body: { callsPerMinute: null, callsPerHour: 200 } },
      ]),
    );
  });

  test('refuses a limit that is not a whole number of 1 or more, and saves nothing', async ({ page }) => {
    const puts = await openRoles(page);

    await page.getByLabel('Calls per minute for erp_query').fill('0');
    await page.getByRole('button', { name: /Save \(1 tools\)/ }).click();

    await expect(page.getByText(/Limits must be whole numbers of 1 or more.*erp_query/)).toBeVisible();
    expect(puts).toEqual([]);
  });
});
