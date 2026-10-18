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

async function openServerPage(page: Page, deploymentMode: 'cloud' | 'self-hosted', mcpAuthMode = 'oauth2', slug = 'search') {
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
      return json({ deploymentMode, mcpAuthMode, hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/mcp-servers/s1')) {
      return json({ id: 's1', name: 'Search', slug, isActive: true, apiKeys: [], connectors: [] });
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

  for (const mode of ['cloud', 'self-hosted'] as const) {
    test(`MCP Inspector shows a pre-filled command, a plain link and sign-in steps (${mode})`, async ({ page }) => {
      await openServerPage(page, mode);
      await openClient(page, 'MCP Inspector');

      const modal = page.locator('div.fixed').filter({ hasText: 'Connect to MCP Inspector' });

      // The command points the Inspector at exactly the endpoint shown on the page.
      const endpoint = (await modal.locator('code', { hasText: /\/mcp\/s1$/ }).textContent())!.trim();
      const command = modal.locator('code', { hasText: 'npx @modelcontextprotocol/inspector' });
      await expect(command).toHaveText(`npx @modelcontextprotocol/inspector --server-url "${endpoint}" --transport http`);

      // The link opens the local Inspector with no query string, so no credentials can leak.
      await expect(modal.getByRole('link', { name: 'Open in MCP Inspector' })).toHaveAttribute('href', 'http://localhost:6274/');
      await expect(modal).toContainText('X-API-Key');
    });
  }
});

test.describe('MCP server Share card', () => {
  test('copies README badges with https install links and loads nothing third-party', async ({ page, context }) => {
    const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const foreign: string[] = [];
    const appHost = new URL(origin).hostname;
    page.on('request', (req) => {
      const host = new URL(req.url()).hostname;
      if (!req.url().startsWith('data:') && host !== appHost && host !== 'localhost' && host !== '127.0.0.1') {
        foreign.push(req.url());
      }
    });

    await openServerPage(page, 'self-hosted');
    const card = page.getByTestId('share-server');
    await expect(card.getByText('Share this server')).toBeVisible();
    await expect(card.getByTestId('share-preview').getByRole('link')).toHaveCount(2);
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card.getByRole('button', { name: /copy/i })).toHaveCount(2);

    const endpoint = (await page.locator('code', { hasText: /\/mcp\/s1$/ }).first().textContent())!.trim();
    // The dev server runs on localhost, so the warning must show.
    await expect(card.getByTestId('share-localhost-warning')).toBeVisible();

    await card.getByRole('button', { name: 'Copy Markdown' }).click();
    await expect(card.getByRole('button', { name: 'Copied!' })).toBeVisible();
    const md = await page.evaluate(() => navigator.clipboard.readText());

    expect(md).not.toMatch(/cursor:\/\/|vscode:|X-API-Key|token|cookie/i);
    const links = [...md.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    const cursorUrl = new URL(links.find((l) => l.startsWith('https://cursor.com/en/install-mcp'))!);
    const vscodeUrl = new URL(links.find((l) => l.startsWith('https://vscode.dev/redirect/mcp/install'))!);
    expect(cursorUrl.searchParams.get('name')).toBe('search');
    expect(JSON.parse(Buffer.from(cursorUrl.searchParams.get('config')!, 'base64').toString())).toEqual({ url: endpoint });
    expect(JSON.parse(vscodeUrl.searchParams.get('config')!)).toEqual({ name: 'search', type: 'http', url: endpoint });

    const previewHrefs = await card.getByTestId('share-preview').getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(previewHrefs).toEqual([
      links.find((l) => l.startsWith('https://cursor.com/en/install-mcp')),
      links.find((l) => l.startsWith('https://vscode.dev/redirect/mcp/install')),
    ]);

    await card.getByRole('button', { name: 'Copy HTML' }).click();
    const html = await page.evaluate(() => navigator.clipboard.readText());
    expect(html).toContain('<a href="https://cursor.com/en/install-mcp?');
    expect(html).toContain('<a href="https://vscode.dev/redirect/mcp/install?');
    expect(html).not.toMatch(/cursor:\/\/|vscode:|X-API-Key/);

    await card.screenshot({ path: process.env.SHARE_SCREENSHOT || test.info().outputPath('share-preview.png') });
    expect(foreign).toEqual([]);
  });

  test('parentheses in the slug cannot break out of the Markdown badge link', async ({ page, context }) => {
    const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const slug = "x)(www.evil.example!*'";
    await openServerPage(page, 'self-hosted', 'oauth2', slug);
    const card = page.getByTestId('share-server');
    await card.getByRole('button', { name: 'Copy Markdown' }).click();
    const md = await page.evaluate(() => navigator.clipboard.readText());

    const links = [...md.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    expect(links).toHaveLength(4); // 2 images + 2 install links
    const installLinks = links.filter((l) => /install-mcp|mcp\/install/.test(l));
    expect(installLinks).toHaveLength(2);
    for (const link of installLinks) {
      expect(link).not.toMatch(/[()!*']/);
      expect(md).toContain(`(${link})`);
    }
    const cursorUrl = new URL(installLinks.find((l) => l.startsWith('https://cursor.com/en/install-mcp'))!);
    const vscodeUrl = new URL(installLinks.find((l) => l.startsWith('https://vscode.dev/redirect/mcp/install'))!);
    expect(cursorUrl.searchParams.get('name')).toBe(slug);
    expect(vscodeUrl.searchParams.get('name')).toBe(slug);
    expect(JSON.parse(vscodeUrl.searchParams.get('config')!).name).toBe(slug);

    // Preview badges link to the same https URLs that get shared.
    const previewHrefs = await card.getByTestId('share-preview').getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(previewHrefs).toEqual(installLinks);
  });

  test('hides the Share card until the auth mode is known', async ({ page }) => {
    await openServerPage(page, 'self-hosted', '');
    await expect(page.getByTestId('share-server')).toHaveCount(0);
  });

  test('in-app Cursor and VS Code buttons keep their deep links', async ({ page }) => {
    await openServerPage(page, 'self-hosted');
    await openClient(page, 'Cursor');
    const href = await page.getByRole('link', { name: 'Open in Cursor' }).getAttribute('href');
    const endpoint = (await page.locator('code', { hasText: /\/mcp\/s1$/ }).first().textContent())!.trim();
    expect(href).toBe(`cursor://anysphere.cursor-deeplink/mcp/install?name=search&config=${btoa(JSON.stringify({ url: endpoint }))}`);
    await page.keyboard.press('Escape');
    await page.goto('/mcp-server/s1');
    await openClient(page, 'VS Code');
    await expect(page.getByRole('link', { name: 'Open in VS Code' })).toHaveAttribute(
      'href',
      `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'search', type: 'http', url: endpoint }))}`,
    );
  });

  test('explains that badges need OAuth in legacy mode', async ({ page }) => {
    await openServerPage(page, 'self-hosted', 'legacy');
    const card = page.getByTestId('share-server');
    await expect(card.getByTestId('share-oauth-required')).toContainText('MCP_AUTH_MODE=oauth2');
    await expect(card.getByRole('button', { name: 'Copy Markdown' })).toHaveCount(0);
    await expect(card.getByTestId('share-preview')).toHaveCount(0);
  });
});
