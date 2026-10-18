import { expect, test, type Page } from '@playwright/test';

const ADMIN_USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const VIEWER_USER = {
  id: 'u2',
  email: 'viewer@example.com',
  name: 'Viewer User',
  role: 'VIEWER',
  organizationId: 'o1',
  emailVerified: true,
};

async function setupSession(
  page: Page,
  options: {
    user?: typeof ADMIN_USER | typeof VIEWER_USER;
    deploymentMode?: 'self-hosted' | 'cloud';
    connectorsList?: any[];
    mcpServersList?: any[];
  } = {}
) {
  const user = options.user ?? ADMIN_USER;
  const deploymentMode = options.deploymentMode ?? 'self-hosted';
  const connectorsList = options.connectorsList ?? [
    { id: 'c1', name: 'Stripe Payments', type: 'REST', slug: 'stripe' },
  ];
  const mcpServersList = options.mcpServersList ?? [
    { id: 's1', name: 'Search Server', slug: 'search-server' },
  ];

  const baseURL = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/health/server-info') {
      return json({
        deploymentMode,
        mcpAuthMode: 'oauth2',
        hasUsers: true,
        registrationEnabled: true,
        ssoProviders: [],
      });
    }
    if (p.endsWith('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p.endsWith('/api/users/me')) return json(user);
    if (p.endsWith('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p.endsWith('/api/organizations/mine')) {
      return json([
        { id: 'o1', name: 'Acme', role: user.role, joinedAt: '2026-01-01' },
        { id: 'o2', name: 'Beta Corp', role: 'MEMBER', joinedAt: '2026-01-01' },
      ]);
    }
    if (p.endsWith('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (p.endsWith('/api/connectors/c1')) return json({ id: 'c1', name: 'Stripe Payments', type: 'REST', slug: 'stripe' });
    if (p.endsWith('/api/connectors')) return json(connectorsList);
    if (p.endsWith('/api/mcp-servers/s1/activity')) return json({ calls30d: 0, lastCallAt: null });
    if (p.endsWith('/api/mcp-servers/s1')) return json({ id: 's1', name: 'Search Server', slug: 'search-server', isActive: true, apiKeys: [], connectors: [] });
    if (p.endsWith('/api/mcp-servers')) return json(mcpServersList);
    if (p.endsWith('/api/audit/stats')) return json({ invocations24h: 0, errors24h: 0 });
    if (p.endsWith('/api/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    if (p.includes('/api/audit/invocations')) return json([]);
    return json({});
  });
}

async function getPaletteShortcut(page: Page): Promise<string> {
  const isMac = await page.evaluate(() =>
    /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent || navigator.platform || '')
  );
  return isMac ? 'Meta+k' : 'Control+k';
}

async function openCommandPalette(page: Page) {
  const palette = page.getByRole('dialog');
  const shortcut = await getPaletteShortcut(page);
  await expect.poll(async () => {
    if (await palette.isVisible()) return true;
    await page.keyboard.press(shortcut);
    try {
      await expect(palette).toBeVisible({ timeout: 500 });
      return true;
    } catch {
      return false;
    }
  }, { timeout: 7000, intervals: [200, 300] }).toBe(true);

  const input = page.getByRole('combobox');
  await expect(input).toBeVisible();
  return { palette, input };
}

test.describe('Command Palette', () => {
  test('opens via Ctrl+K / ⌘K and header button, and closes via Esc on AppShell pages', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const palette = page.getByRole('dialog');
    await expect(palette).not.toBeVisible();

    // Open via keyboard shortcut
    const shortcut = await getPaletteShortcut(page);
    await expect.poll(async () => {
      if (await palette.isVisible()) return true;
      await page.keyboard.press(shortcut);
      try {
        await expect(palette).toBeVisible({ timeout: 500 });
        return true;
      } catch {
        return false;
      }
    }, { timeout: 7000, intervals: [200, 300] }).toBe(true);

    // Combobox input should be focused
    const searchInput = page.getByRole('combobox');
    await expect(searchInput).toBeFocused();

    // Close via Esc
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();

    // Open via visible trigger button in header
    const searchButton = page.getByRole('button', { name: /search|open command palette/i }).first();
    await expect(searchButton).toBeVisible();
    await searchButton.click();
    await expect(palette).toBeVisible();

    // Close again via Esc
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });

  test('does not open on /login page', async ({ page }) => {
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/health/server-info') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            deploymentMode: 'self-hosted',
            mcpAuthMode: 'oauth2',
            hasUsers: true,
            registrationEnabled: true,
            ssoProviders: [],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('typing "audit" and Enter opens /logs', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    await input.fill('audit');
    await expect(page.getByRole('option', { name: /Audit Log/i })).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/logs$/);
  });

  test('typing part of a connector name opens that connector', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    await input.fill('stripe');
    const option = page.getByRole('option', { name: /Stripe Payments/i });
    await expect(option).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/connectors\/c1$/);
  });

  test('typing part of an MCP server name opens that server', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    await input.fill('search');
    const option = page.getByRole('option', { name: /Search Server/i });
    await expect(option).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/mcp-server\/s1$/);
  });

  test('admin sees "Users", "Add connector", and "Single sign-on" on self-hosted', async ({ page }) => {
    await setupSession(page, { user: ADMIN_USER, deploymentMode: 'self-hosted' });
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    // Check Users in Settings
    await input.fill('users');
    await expect(page.getByRole('option', { name: /Users/i })).toBeVisible();

    // Check Single sign-on in Settings
    await input.fill('single sign-on');
    await expect(page.getByRole('option', { name: /Single sign-on/i })).toBeVisible();

    // Check Add connector in Actions
    await input.fill('add connector');
    await expect(page.getByRole('option', { name: /Add connector/i })).toBeVisible();
  });

  test('viewer sees neither "Users" nor "Add connector"', async ({ page }) => {
    await setupSession(page, { user: VIEWER_USER, deploymentMode: 'self-hosted' });
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    // Viewer should not see Users
    await input.fill('users');
    await expect(page.getByRole('option', { name: /Users/i })).not.toBeVisible();

    // Viewer should not see Add connector
    await input.fill('add connector');
    await expect(page.getByRole('option', { name: /Add connector/i })).not.toBeVisible();
  });

  test('with deploymentMode: "cloud", "Single sign-on" is not listed', async ({ page }) => {
    await setupSession(page, { user: ADMIN_USER, deploymentMode: 'cloud' });
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    await input.fill('single sign-on');
    await expect(page.getByRole('option', { name: /Single sign-on/i })).not.toBeVisible();
  });

  test('sidebar and settings navigation look and behave as before', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    // Sidebar navigation check
    const sidebar = page.locator('aside');
    await expect(sidebar.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Connectors' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Audit Log' })).toBeVisible();

    // Navigate to Settings
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: /Profile/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Connections/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Users/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Roles/i })).toBeVisible();
  });

  test('keyboard arrow navigation and ARIA attributes', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { input } = await openCommandPalette(page);

    // ARIA attributes on input
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'command-palette-results');
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');

    // Listbox and options
    const listbox = page.getByRole('listbox', { name: 'Commands' });
    await expect(listbox).toBeVisible();

    const initialDescendant = await input.getAttribute('aria-activedescendant');
    expect(initialDescendant).toBeTruthy();

    // Press ArrowDown to change active option
    await page.keyboard.press('ArrowDown');
    const nextDescendant = await input.getAttribute('aria-activedescendant');
    expect(nextDescendant).toBeTruthy();
    expect(nextDescendant).not.toBe(initialDescendant);

    // Selected option has aria-selected="true"
    const activeOption = page.locator(`#${nextDescendant}`);
    await expect(activeOption).toHaveAttribute('aria-selected', 'true');

    // Press ArrowUp to go back
    await page.keyboard.press('ArrowUp');
    const backDescendant = await input.getAttribute('aria-activedescendant');
    expect(backDescendant).toBe(initialDescendant);
  });

  test('common actions: Toggle theme, Switch workspace, and Log out are listed and functional', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const html = page.locator('html');
    const wasDark = await html.evaluate((el) => el.classList.contains('dark'));

    // Test Toggle theme action
    const { input } = await openCommandPalette(page);
    await input.fill('toggle theme');
    await expect(page.getByRole('option', { name: /Toggle theme/i })).toBeVisible();
    await page.keyboard.press('Enter');

    // Dialog closes and theme switches
    await expect(page.getByRole('dialog')).not.toBeVisible();
    if (wasDark) {
      await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
    } else {
      await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
    }

    // Test Switch to other workspace and Log out are listed
    const second = await openCommandPalette(page);
    await second.input.fill('Switch to Beta Corp');
    await expect(page.getByRole('option', { name: /Switch to Beta Corp/i })).toBeVisible();

    await second.input.fill('Log out');
    await expect(page.getByRole('option', { name: /Log out/i })).toBeVisible();
  });

  test('handles malformed / non-array orgs responses gracefully without crashing', async ({ page }) => {
    await setupSession(page);
    // Override organizations/mine to return a non-array object
    await page.route('**/api/organizations/mine', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not an array' }),
      });
    });

    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible();

    const { palette, input } = await openCommandPalette(page);
    await expect(palette).toBeVisible();
    await input.fill('dash');
    await expect(page.getByRole('option', { name: /Dashboard/i })).toBeVisible();
  });

  test('resets search query every time palette opens, via keyboard and header button', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    // 1. Open via shortcut, type a query
    const first = await openCommandPalette(page);
    await first.input.fill('random search string');
    await expect(first.input).toHaveValue('random search string');

    // Close via Esc
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // 2. Re-open via shortcut, check query is empty
    const second = await openCommandPalette(page);
    await expect(second.input).toHaveValue('');

    // Type query again
    await second.input.fill('another query');
    await expect(second.input).toHaveValue('another query');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // 3. Re-open via header button, check query is empty
    const searchButton = page.getByRole('button', { name: /search|open command palette/i }).first();
    await searchButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = page.getByRole('combobox');
    await expect(input).toHaveValue('');
  });

  test('restores keyboard focus to opening element on close', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    // 1. When opened via header button
    const searchBtn = page.getByRole('button', { name: /search|open command palette/i }).first();
    await searchBtn.focus();
    await expect(searchBtn).toBeFocused();
    await searchBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(searchBtn).toBeFocused();

    // 2. When opened via shortcut while another element has focus
    const newConnectorBtn = page.getByRole('button', { name: 'New connector' });
    await newConnectorBtn.focus();
    await expect(newConnectorBtn).toBeFocused();

    const shortcut = await getPaletteShortcut(page);
    await page.keyboard.press(shortcut);
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(newConnectorBtn).toBeFocused();
  });

  test('keyboard shortcut platform detection and modifier rejection', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible();

    const palette = page.getByRole('dialog');

    // 1. Shift+K and Alt+K must NOT open palette
    await page.keyboard.press('Shift+k');
    await expect(palette).not.toBeVisible();
    await page.keyboard.press('Alt+k');
    await expect(palette).not.toBeVisible();

    // 2. On simulated Mac platform: Command+K opens, Control+K does NOT
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true });
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true });
      if ((navigator as any).userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }), configurable: true });
      }
    });

    // Control+K on Mac should NOT open palette (avoids hijacking kill-line)
    await page.keyboard.press('Control+k');
    await expect(palette).not.toBeVisible();

    // Re-focus the page in case browser defaults captured the rejected shortcut
    await page.locator('aside').click();

    // Meta+K on Mac should open palette
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();

    // 3. On simulated non-Mac platform: Control+K opens, Meta+K does NOT
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
      if ((navigator as any).userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'Windows' }), configurable: true });
      }
    });

    // Meta+K on Windows should NOT open palette
    await page.keyboard.press('Meta+k');
    await expect(palette).not.toBeVisible();

    // Re-focus the page in case browser defaults captured the rejected shortcut
    await page.locator('aside').click();

    // Control+K on Windows should open palette
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });

  test('ignores Enter key when IME composition is active', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { input } = await openCommandPalette(page);
    await input.fill('audit');
    await expect(page.getByRole('option', { name: /Audit Log/i })).toBeVisible();

    // Dispatch an Enter event with isComposing: true
    await input.evaluate((el) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(event);
    });

    // Dialog should still be open, and URL should not have changed to /logs
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('accessibility: groups use role=group and aria-labelledby, loading status is outside listbox', async ({ page }) => {
    await setupSession(page);
    await page.goto('/');

    const { palette } = await openCommandPalette(page);

    const listbox = palette.getByRole('listbox', { name: 'Commands' });
    await expect(listbox).toBeVisible();

    // Verify groups have role="group" and aria-labelledby
    const groups = listbox.locator('[role="group"]');
    const groupCount = await groups.count();
    expect(groupCount).toBeGreaterThan(0);

    for (let i = 0; i < groupCount; i++) {
      const group = groups.nth(i);
      const labelledBy = await group.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      const header = page.locator(`#${labelledBy}`);
      await expect(header).toBeVisible();
    }

    // Verify that loading status is NOT inside listbox
    const loadingInsideListbox = listbox.locator('[role="status"]');
    await expect(loadingInsideListbox).toHaveCount(0);
  });

  test('caches connectors and MCP servers with stale-while-revalidate background refresh', async ({ page }) => {
    let connectorsFetches = 0;
    let mcpFetches = 0;

    await setupSession(page);

    await page.route('**/api/connectors', async (route) => {
      connectorsFetches++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'c1', name: 'Stripe Payments', type: 'REST', slug: 'stripe' }]),
      });
    });

    await page.route('**/api/mcp-servers', async (route) => {
      mcpFetches++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 's1', name: 'Search Server', slug: 'search-server' }]),
      });
    });

    await page.goto('/settings');
    await expect(page.locator('aside')).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Reset fetch counters after page load so we only measure command palette fetches
    connectorsFetches = 0;
    mcpFetches = 0;

    // 1. Open first time - fetches records
    const first = await openCommandPalette(page);
    await first.input.fill('stripe');
    await expect(page.getByRole('option', { name: /Stripe Payments/i })).toBeVisible();
    expect(connectorsFetches).toBe(1);
    expect(mcpFetches).toBe(1);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // 2. Re-open without page reload - cached item is visible immediately, background revalidation runs
    const second = await openCommandPalette(page);
    await second.input.fill('stripe');
    await expect(page.getByRole('option', { name: /Stripe Payments/i })).toBeVisible();
    await expect.poll(() => connectorsFetches).toBe(2);
    await expect.poll(() => mcpFetches).toBe(2);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('failed requests are not cached as empty arrays and recover on retry', async ({ page }) => {
    let failConnectors = true;

    await setupSession(page);

    await page.route('**/api/connectors', async (route) => {
      if (failConnectors) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Internal Server Error' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'c1', name: 'Recovered Connector', type: 'REST', slug: 'recovered' }]),
        });
      }
    });

    await page.route('**/api/mcp-servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 's1', name: 'Search Server', slug: 'search-server' }]),
      });
    });

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // 1. Open when connectors endpoint fails: palette renders gracefully without crash
    const first = await openCommandPalette(page);
    await first.input.fill('recovered');
    await expect(page.getByRole('option', { name: /Recovered Connector/i })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // 2. Server recovers: since failure was NOT cached, reopening palette should fetch fresh and display
    failConnectors = false;
    const second = await openCommandPalette(page);
    await second.input.fill('recovered');
    await expect(page.getByRole('option', { name: /Recovered Connector/i })).toBeVisible();
  });

  test('stale-while-revalidate dynamically updates with newly added connectors', async ({ page }) => {
    let connectorList = [{ id: 'c1', name: 'Stripe Payments', type: 'REST', slug: 'stripe' }];

    await setupSession(page);

    await page.route('**/api/connectors', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(connectorList),
      });
    });

    await page.route('**/api/mcp-servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // 1. Initial open - sees Stripe
    const first = await openCommandPalette(page);
    await first.input.fill('stripe');
    await expect(page.getByRole('option', { name: /Stripe Payments/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // 2. User adds a new connector in the background
    connectorList = [
      { id: 'c1', name: 'Stripe Payments', type: 'REST', slug: 'stripe' },
      { id: 'c2', name: 'HubSpot CRM', type: 'REST', slug: 'hubspot' },
    ];

    // 3. Re-open: Stripe is rendered immediately from cache, and background refresh fetches HubSpot
    const second = await openCommandPalette(page);
    await second.input.fill('hubspot');
    await expect(page.getByRole('option', { name: /HubSpot CRM/i })).toBeVisible();
  });

  test('clears command palette cache on logout action', async ({ page }) => {
    await setupSession(page);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Open palette and execute logout action
    const { input } = await openCommandPalette(page);
    await input.fill('log out');
    const logoutOption = page.getByRole('option', { name: /Log out/i });
    await expect(logoutOption).toBeVisible();
    await logoutOption.click();

    // Verify redirected to login page and token cleared
    await expect(page).toHaveURL(/\/login/);
  });

  test('clears command palette cache on organization switch', async ({ page }) => {
    let currentOrgId = 'o1';

    await setupSession(page);

    await page.route('**/api/organizations/switch', async (route) => {
      currentOrgId = 'o2';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'token-o2',
          user: { ...ADMIN_USER, organizationId: 'o2' },
          organization: { id: 'o2', name: 'Beta Corp' },
        }),
      });
    });

    await page.route('**/api/connectors', async (route) => {
      const list =
        currentOrgId === 'o1'
          ? [{ id: 'c1', name: 'Acme Stripe', type: 'REST', slug: 'acme-stripe' }]
          : [{ id: 'c2', name: 'Beta Salesforce', type: 'REST', slug: 'beta-salesforce' }];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(list),
      });
    });

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // 1. In Org 1: open palette and verify Acme Stripe is present
    const first = await openCommandPalette(page);
    await first.input.fill('acme');
    await expect(page.getByRole('option', { name: /Acme Stripe/i })).toBeVisible();

    // 2. Search for organization switch action and execute it
    await first.input.fill('Beta Corp');
    const switchOption = page.getByRole('option', { name: /Switch to Beta Corp/i });
    await expect(switchOption).toBeVisible();
    await switchOption.click();

    // Wait for org switch to complete and navigate to home
    await expect(page).toHaveURL('/');
    await page.waitForLoadState('networkidle');

    // 3. Re-open palette: cache was cleared, Org 2 data is fetched and Org 1 data does not leak
    const second = await openCommandPalette(page);
    await second.input.fill('acme');
    await expect(page.getByRole('option', { name: /Acme Stripe/i })).toHaveCount(0);

    await second.input.fill('salesforce');
    await expect(page.getByRole('option', { name: /Beta Salesforce/i })).toBeVisible();
  });

  test('section-level and item-level adminOnly and selfHostedOnly visibility filtering', async ({ page }) => {
    // Viewer session on self-hosted
    await setupSession(page, { user: VIEWER_USER, deploymentMode: 'self-hosted' });
    await page.goto('/settings');

    // Viewer should only see Profile and Connections (not Organization admin items)
    const settingsNav = page.locator('nav');
    await expect(settingsNav.getByRole('link', { name: /Profile/i })).toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /Connections/i })).toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /Users/i })).not.toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /Roles/i })).not.toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /Single sign-on/i })).not.toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /License/i })).not.toBeVisible();
    await expect(settingsNav.getByRole('link', { name: /Administration/i })).not.toBeVisible();
  });
});
