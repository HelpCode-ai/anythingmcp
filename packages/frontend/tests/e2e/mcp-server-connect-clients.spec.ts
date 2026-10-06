import { expect, test, type Page } from '@playwright/test';

/**
 * The Quick Connect modals on an MCP server page. On AnythingMCP Cloud the
 * Claude modals lead with AnythingMCP's listing in the Claude Directory; a
 * self-hosted instance must not show it, since that listing only ever
 * connects to Cloud. Meta Muse has its own modal with this server's URL.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const DIRECTORY_URL = 'https://claude.ai/directory/anythingmcp';

async function openServerPage(page: Page, deploymentMode: 'cloud' | 'self-hosted') {
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  let serverInfoServed = false;
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/health/server-info') {
      serverInfoServed = true;
      return json({ deploymentMode, mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/mcp-servers/s1')) {
      return json({ id: 's1', name: 'Search', slug: 'search', isActive: true, apiKeys: [], connectors: [] });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p.endsWith('/users/me')) return json(USER);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (p.endsWith('/license/status')) return json({ plan: 'community', status: 'active' });
    if (p.endsWith('/connectors')) return json([]);
    return json({});
  });

  await page.goto('/mcp-server/s1');
  await expect(page.getByText('Assigned connectors (0)')).toBeVisible();
  await expect.poll(() => serverInfoServed).toBe(true);
}

// Each Quick Connect button is named by its initials badge plus the client name.
async function openClient(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('button', { name: new RegExp(`^\\w+ ${escaped}$`) }).click();
  await expect(page.getByRole('heading', { name: `Connect to ${name}` })).toBeVisible();
}

test.describe('MCP server Quick Connect', () => {
  for (const client of ['Claude (Web)', 'Claude Desktop']) {
    test(`${client} leads with the Claude Directory on Cloud`, async ({ page }) => {
      await openServerPage(page, 'cloud');
      await openClient(page, client);

      const directory = page.getByTestId('claude-directory');
      await expect(directory).toContainText('Fastest: add AnythingMCP from the Claude Directory');
      await expect(directory.getByRole('link', { name: 'Open the Claude Directory' })).toHaveAttribute('href', DIRECTORY_URL);
      // The custom-connector steps for this one server are still there.
      await expect(page.getByRole('link', { name: 'Add to Claude' })).toBeVisible();
    });

    test(`${client} does not offer the Claude Directory when self-hosted`, async ({ page }) => {
      await openServerPage(page, 'self-hosted');
      await openClient(page, client);

      await expect(page.getByRole('link', { name: 'Add to Claude' })).toBeVisible();
      await expect(page.getByTestId('claude-directory')).toHaveCount(0);
      await expect(page.locator(`a[href="${DIRECTORY_URL}"]`)).toHaveCount(0);
    });
  }

  test('Meta Muse shows its steps, this server\'s URL and the chat prompt', async ({ page }) => {
    await openServerPage(page, 'cloud');
    await openClient(page, 'Meta Muse');

    const modal = page.locator('div.fixed').filter({ hasText: 'Connect to Meta Muse' });
    await expect(modal.getByText('Settings → Connectors → Add custom connector')).toBeVisible();
    await expect(modal.locator('code', { hasText: /\/mcp\/s1$/ })).toBeVisible();
    await expect(modal.locator('pre')).toContainText('Transport: remote streamable HTTP');
    await expect(modal.locator('pre')).toContainText(/URL: .*\/mcp\/s1\n/);
    await expect(modal).toContainText('US and Canada');
    await expect(modal.getByTestId('claude-directory')).toHaveCount(0);
  });
});
