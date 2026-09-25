import { expect, test, type Page } from '@playwright/test';

/**
 * Assigning a connector to an MCP server is saved the moment the box is
 * ticked. It used to wait for a "Save assignments" button below the list,
 * off screen once a workspace had a few connectors; a server set up that way
 * looked configured and exposed no tools, and Claude showed nothing.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const CONNECTORS = [
  { id: 'c1', name: 'Google Search Console', type: 'REST', tools: [{ id: 't1', name: 'gsc_list_sites' }] },
  { id: 'c2', name: 'OpenPLZ Germany', type: 'REST', tools: [{ id: 't2', name: 'openplz_lookup_postalcode' }] },
];

async function openServerPage(page: Page, putStatus: number) {
  const puts: string[][] = [];
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/mcp-servers/s1/connectors') && req.method() === 'PUT') {
      puts.push((req.postDataJSON() as { connectorIds: string[] }).connectorIds);
      return putStatus === 200 ? json({ ok: true }) : json({ message: 'Server unavailable' }, putStatus);
    }
    if (url.includes('/api/mcp-servers/s1')) {
      return json({ id: 's1', name: 'Search', slug: 'search', isActive: true, apiKeys: [], connectors: [] });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json(CONNECTORS);
    return json({});
  });

  await page.goto('/mcp-server/s1');
  await expect(page.getByText('Assigned connectors (0)')).toBeVisible();
  return puts;
}

test.describe('MCP server connector assignments', () => {
  test('ticking a connector saves it, with no separate save button', async ({ page }) => {
    const puts = await openServerPage(page, 200);

    await expect(page.getByRole('button', { name: 'Save assignments' })).toHaveCount(0);
    await page.getByText('Google Search Console').click();

    await expect(page.getByRole('status')).toHaveText('Saved');
    await expect(page.getByText('Assigned connectors (1)')).toBeVisible();
    await expect(page.getByText('Refresh tools list')).toBeVisible();
    expect(puts).toEqual([['c1']]);

    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await expect(page.getByText('Assigned connectors (2)')).toBeVisible();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1].sort()).toEqual(['c1', 'c2']);
  });

  test('a failed save puts the tick back and says so', async ({ page }) => {
    const puts = await openServerPage(page, 500);

    await page.getByText('Google Search Console').click();

    await expect(page.getByRole('status')).toContainText('Not saved');
    await expect(page.getByText('Assigned connectors (0)')).toBeVisible();
    expect(puts).toEqual([['c1']]);
  });
});
