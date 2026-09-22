import { devices, expect, test, type Page } from '@playwright/test';

/**
 * Phone-width layout guard.
 *
 * Every authenticated page is rendered at an iPhone viewport with data
 * shaped like the worst cases seen in production (long base URLs, a
 * 30-day timeline, wide audit rows, adapters with long auth labels, users
 * and roles tables, the tool editor open) and we assert that nothing is
 * wider than the screen: no horizontal scrolling on the document, on
 * <main> or on the sticky header.
 *
 * Same fake-session approach as redesign.spec.ts: seed the cookie +
 * localStorage, stub /api/*.
 */

// The iPhone profile defaults to WebKit; CI only installs Chromium, and
// the overflow checks are engine-agnostic.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium', browserName: 'chromium' });

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const TOOL = {
  id: 't1',
  name: 'gr_search_stations',
  description: 'Find Georgian Railway stations by name and return their station_code, which every other tool needs.',
  isEnabled: true,
  useProxy: false,
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: '1-based page number, for paging through the station list' },
      limit: { type: 'number', description: 'Maximum number of stations to return' },
      query: { type: 'string', description: 'Station name or fragment, matched case-insensitively' },
    },
    required: ['query'],
  },
  endpointMapping: {
    method: 'GET',
    path: '/api/stations',
    parameters: [
      { name: 'page', type: 'number', description: '1-based page number, for paging through the station list', target: 'query', required: false },
      { name: 'limit', type: 'number', description: 'Maximum number of stations to return', target: 'query', required: false },
      { name: 'query', type: 'string', description: 'Station name or fragment, matched case-insensitively', target: 'query', required: true },
    ],
  },
  responseMapping: { cacheTtl: 86400 },
};

const CONNECTORS = [
  {
    id: 'c1',
    name: 'DATEV Online APIs',
    type: 'REST',
    baseUrl: 'https://accounting-clients.api.datev.de/platform-sandbox/v2/clients-with-a-very-long-path',
    authType: 'OAUTH2',
    isActive: true,
    tools: [TOOL],
    headers: null,
    config: null,
    envVars: null,
    createdAt: '2026-08-14T10:00:00Z',
    instructions: '## DATEV\n\n| Station | Code |\n|---|---|\n| Tbilisi | `56014` |',
  },
  {
    id: 'c2',
    name: 'API-Football v3',
    type: 'REST',
    baseUrl: 'https://v3.football.api-sports.io',
    authType: 'API_KEY',
    isActive: true,
    tools: [],
    createdAt: '2026-08-14T10:00:00Z',
  },
];

const SERVERS = [
  { id: 's1', name: 'Default (Test User)', slug: 'default', isActive: true, description: '', instructions: '', connectors: [], apiKeys: [], clientsConnected: 0 },
];

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 22 + i));
    return { date: d.toISOString().slice(0, 10), success: i % 4 === 0 ? 12 : 0, error: i % 9 === 0 ? 1 : 0, timeout: 0, avgDuration: 40 };
  });

const LOGS = Array.from({ length: 12 }, (_, i) => ({
  id: `l${i}`,
  createdAt: `2026-09-1${i % 9}T20:50:00Z`,
  status: i === 7 ? 'ERROR' : 'SUCCESS',
  durationMs: i === 7 ? 2715 : 13 + i * 7,
  toolId: 't1',
  tool: { name: 'af_odds_prematch_with_a_long_name', connector: { name: 'API-Football v3 with a long connector name' } },
  input: { fixture: 12345 },
  output: { ok: true },
  error: i === 7 ? 'Upstream returned 500' : null,
  clientInfo: null,
}));

const ADAPTERS = [
  {
    slug: 'buchhaltungsbutler',
    name: 'BuchhaltungsButler',
    description: 'BuchhaltungsButler — German automated bookkeeping: postings, receipts, bank transactions, customers and suppliers.',
    category: 'accounting',
    region: 'germany',
    toolCount: 6,
    authType: 'CONNECTION_STRING',
    docsUrl: 'https://example.com/docs',
    icon: null,
  },
  {
    slug: 'bundesbank',
    name: 'Deutsche Bundesbank Statistics',
    description: 'Access macroeconomic data, exchange rates, interest rates and financial statistics.',
    category: 'finance',
    region: 'germany',
    toolCount: 3,
    authType: 'NONE',
    docsUrl: 'https://example.com/docs',
    icon: null,
  },
];

const USERS = [
  { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', mcpRoleId: null, createdAt: '2026-01-01T00:00:00Z', deactivatedAt: null },
  { id: 'u2', email: 'someone.with.a.long.address@example-company.de', name: 'Someone Else', role: 'EDITOR', mcpRoleId: null, createdAt: '2026-01-01T00:00:00Z', deactivatedAt: null },
];

async function fakeSession(page: Page) {
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/(api|health)\//, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/health/server-info')
      return json({
        mcpAuthMode: 'oauth2',
        serverUrl: 'https://cloud.anythingmcp.com',
        mcpEndpoint: '/mcp',
        deploymentMode: 'self-hosted',
        hasUsers: true,
        registrationEnabled: false,
        ssoProviders: [],
        oauthEndpoints: {
          wellKnown: '/.well-known/oauth-authorization-server',
          authorize: '/authorize',
          token: '/token',
          register: '/register',
        },
      });
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p.endsWith('/users/me')) return json(USER);
    if (p.endsWith('/users')) return json(USERS);
    if (p.endsWith('/users/invitations')) return json([]);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (p.endsWith('/license/status')) return json({ plan: 'community', status: 'active' });
    if (p.endsWith('/connectors/proxy-availability')) return json({ available: false });
    if (p.includes('/connectors/health-check'))
      return json({ total: 2, healthy: 1, unhealthy: 1, connectors: [
        { name: 'DATEV Online APIs', status: 'healthy', latencyMs: 120 },
        { name: 'API-Football v3', status: 'unhealthy', latencyMs: 0 },
      ] });
    if (p.endsWith('/connectors/c1')) return json(CONNECTORS[0]);
    if (p.endsWith('/connectors')) return json(CONNECTORS);
    if (p.endsWith('/mcp-servers/s1')) return json(SERVERS[0]);
    if (p.endsWith('/mcp-servers')) return json(SERVERS);
    if (p.endsWith('/adapters')) return json(ADAPTERS);
    if (p.endsWith('/roles')) return json([{ id: 'r1', name: 'Read-only', description: '', _count: { users: 1, toolAccess: 3 } }]);
    if (p.includes('/audit/stats')) return json({ invocations24h: 0, errors24h: 0, invocations7d: 0, totalInvocations: 67 });
    if (p.includes('/audit/analytics'))
      return json({ daily: days(Number(url.searchParams.get('days') || 30)), topTools: [{ name: 'af_fixtures', count: 24, errors: 0, avgDuration: 30 }], totalInvocations: 67, successRate: 99, avgDuration: 40 });
    if (p.includes('/audit/breakdowns'))
      return json({ days: 30, total: 67, errors: 1, proxyCalls: 0, estCostMicros: 0, rates: { callMicros: 0, proxyCallMicros: 0 }, byConnector: [], byServer: [], byUser: [], byClient: [] });
    if (p.includes('/audit/invocations')) return json(LOGS);
    if (p.includes('/knowledge-graph/skills')) return json({ items: [], total: 0, counts: { pending: 0, applied: 0, dismissed: 0 }, take: 25, skip: 0 });
    if (p.includes('/knowledge-graph/settings')) return json({ enabled: true, llmEnabled: true, captureIntent: false, autoExtend: false, skillAutoApply: false, edgeAutoApply: false });
    if (p.includes('/knowledge-graph')) return json({ nodes: [], edges: [], lastBuiltAt: null, enabled: true });
    return json({});
  });
}

/** Screenshots land in .context/mobile (gitignored) for eyeballing. */
async function shot(page: Page, name: string) {
  if (!process.env.MOBILE_SHOTS) return;
  const file = name.replace(/^\//, '').replace(/\//g, '_') || 'dashboard';
  await page.screenshot({ path: `${process.env.MOBILE_SHOTS}/${file}.png`, fullPage: false });
}

/** Widest scrollable box on the page, relative to the viewport. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    // The settings layout nests a second <main>; the shell's is the first.
    const main = document.querySelector('main');
    const header = document.querySelector('header');
    return {
      vw,
      doc: document.documentElement.scrollWidth,
      main: main ? main.scrollWidth : 0,
      header: header ? header.scrollWidth : 0,
    };
  });
}

const ROUTES = [
  '/',
  '/connectors',
  '/connectors/c1',
  '/connectors/store',
  '/connectors/new',
  '/analytics',
  '/logs',
  '/mcp-server',
  '/mcp-server/s1',
  '/knowledge-graph',
  '/knowledge-graph/skills',
  '/settings',
  '/settings/users',
  '/settings/roles',
  '/settings/organization',
];

test.describe('phone layout has no horizontal overflow', () => {
  for (const route of ROUTES) {
    test(route, async ({ page }) => {
      await fakeSession(page);
      await page.goto(route);
      // Let the data effects settle and the lists render.
      await page.locator('main').first().waitFor();
      await page.waitForTimeout(600);
      await shot(page, route);

      // A page that crashed into the error boundary has nothing wide on it,
      // so it would sail through the checks below without being tested.
      await expect(page.getByText('Something went wrong')).toHaveCount(0);

      const o = await overflow(page);
      expect(o.doc, 'document').toBeLessThanOrEqual(o.vw);
      expect(o.main, '<main>').toBeLessThanOrEqual(o.vw);
      expect(o.header, '<header>').toBeLessThanOrEqual(o.vw);

      // The title row is the header's own line on a phone, so no page title
      // is ever ellipsised away.
      const title = page.locator('header').locator('div.truncate').first();
      if (await title.count()) {
        const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(clipped, 'header title is truncated').toBe(false);
      }
    });
  }

  test('tool editor open on a connector', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/connectors/c1');
    await page.getByText('gr_search_stations').first().waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).nth(1).click();
    await page.getByPlaceholder('param_name').first().waitFor();
    await page.getByPlaceholder('param_name').first().scrollIntoViewIfNeeded();
    await shot(page, '/connectors/c1-tool-editor');

    const o = await overflow(page);
    expect(o.main, '<main> with tool editor').toBeLessThanOrEqual(o.vw);
  });

  test('audit log expands a row without overflowing', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/logs');
    await page.getByText('2715ms').first().click();
    await page.getByText('Upstream returned 500').first().waitFor();
    await shot(page, '/logs-expanded');

    const o = await overflow(page);
    expect(o.main, '<main> with expanded log').toBeLessThanOrEqual(o.vw);
  });

  /**
   * The marketplace ships 45 categories. Rendered as a wrapped chip list they
   * filled fourteen rows and pushed the first adapter 635px down the page, so
   * the row is capped and scrolls sideways instead. Both properties are easy
   * to lose the next time somebody touches the filter.
   */
  test('marketplace category filters stay one capped row', async ({ page }) => {
    const manyCategories = Array.from({ length: 45 }, (_, i) => ({
      slug: `adapter-${i}`,
      name: `Adapter ${i}`,
      description: 'An adapter used to fill out the category list.',
      category: `category-number-${i}`,
      region: 'intl',
      toolCount: 3,
      authType: 'API_KEY',
      docsUrl: null,
      icon: null,
    }));
    await fakeSession(page);
    await page.route(/\/api\/adapters$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manyCategories) }));

    await page.goto('/connectors/store');
    await page.getByText('Adapter 0').first().waitFor();
    await page.waitForTimeout(400);

    const row = page.locator('button', { hasText: /^All$/ }).first().locator('..');
    const shape = await row.evaluate((el) => ({
      chips: [...el.children].filter((c) => c.tagName === 'BUTTON').length,
      rows: new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
      overflowX: getComputedStyle(el).overflowX,
      minChipHeight: Math.min(
        ...[...el.children].map((c) => Math.round(c.getBoundingClientRect().height)),
      ),
    }));

    // All + 12 categories + "+N more" — not one chip per category.
    expect(shape.chips, 'chips rendered').toBeLessThanOrEqual(14);
    expect(shape.rows, 'chip rows on a phone').toBe(1);
    expect(shape.overflowX, 'row scrolls sideways').toBe('auto');
    // A target you scroll past with a thumb needs to be bigger than the
    // 26px the desktop chip density gave it.
    expect(shape.minChipHeight, 'chip touch target').toBeGreaterThanOrEqual(32);

    const o = await overflow(page);
    expect(o.doc, 'document').toBeLessThanOrEqual(o.vw);
  });

  test('header keeps the title readable when the toolbar wraps', async ({ page }) => {
    await fakeSession(page);
    await page.goto('/connectors/c1');
    await page.getByRole('button', { name: 'Delete', exact: true }).first().waitFor();

    const title = page.locator('header').getByText('DATEV Online APIs', { exact: true });
    await expect(title).toBeVisible();
    // Once the toolbar wraps to its own line the title has the row to
    // itself, so it must not be ellipsised.
    const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped, 'title is truncated').toBe(false);
  });
});
