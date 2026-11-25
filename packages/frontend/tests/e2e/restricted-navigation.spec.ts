import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * What a member may open, in a workspace whose member visibility is
 * Restricted (lib/member-access.ts, components/member-route-guard.tsx).
 *
 * The sidebar, the settings navigation and the command palette list only the
 * pages a restricted member can use, and a direct URL to any other page ends
 * on the connectors list, without that page being drawn and without its
 * requests being sent. A VIEWER and an EDITOR differ (an EDITOR still creates
 * connectors); admins and members of an Open workspace keep everything.
 *
 * Also here, because they are the same follow-up: the workspace-creation
 * form, the unsaved state of the member visibility setting, the invite
 * form's default role, connector owners for admins, and one browser holding
 * two accounts in two tabs. The API is mocked, as in the other smoke tests.
 */

const BASE_URL = 'http://localhost:3100';

type Role = 'ADMIN' | 'EDITOR' | 'VIEWER';

interface Setup {
  role: Role;
  mode: 'open' | 'restricted';
  deploymentMode?: 'self-hosted' | 'cloud';
  /** Rows of GET /api/mcp-servers (a restricted member is listed only their own). */
  servers?: unknown[];
  connectors?: Array<{ id: string } & Record<string, unknown>>;
  /** GET /api/memory/status. */
  memory?: { licensed: boolean; access: string; isCurator: boolean };
  /** Roles returned by /api/roles (admin only). */
  roles?: unknown[];
  /** Members returned by /api/users (admin only). */
  members?: unknown[];
  user?: { id: string; email: string; name: string };
  /**
   * Her very first load in this browser: no `amcp_nav` cookie yet. Otherwise
   * a restricted member's session carries the cookie her earlier loads left.
   */
  firstVisit?: boolean;
  /** How many requests for GET /api/mcp-servers fail (500) before it answers. */
  serversFailures?: number;
  /** Delay of GET /api/users/me, in ms. */
  meDelay?: number;
  /** GET /api/license/usage (Cloud). */
  usage?: unknown;
}

const OWN_SERVER = { id: 's1', name: 'Default (Rita)', slug: 'default-rita', isActive: true, connectors: [] };

/** Requests only a workspace admin's pages make, plus the ones the API refuses to a restricted member. */
const ADMIN_ONLY_CALLS = /^\/api\/(users$|users\/invitations|roles|identity-providers|admin\/|knowledge-graph($|\/skills|\/settings|\/stats)|learning\/projects|adapters$)/;

function userFor(setup: Setup) {
  return {
    id: 'u1',
    email: 'rita@example.test',
    name: 'Rita',
    ...setup.user,
    role: setup.role,
    organizationId: 'o1',
    emailVerified: true,
  };
}

async function mockApi(page: Page, setup: Setup, currentUser: () => ReturnType<typeof userFor>) {
  const state = { mode: setup.mode, serversFailures: setup.serversFailures ?? 0 };
  const puts: unknown[] = [];
  /** Every API path the page asked for. */
  const paths: string[] = [];
  await page.route(/\/(api|health)\//, async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    paths.push(p);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const user = currentUser();

    if (p === '/health/server-info') {
      return json({
        deploymentMode: setup.deploymentMode ?? 'self-hosted',
        mcpAuthMode: 'oauth2',
        hasUsers: true,
        ssoProviders: [],
      });
    }
    if (p === '/api/settings/member-visibility') {
      return json({ mode: state.mode, restrictedForMe: state.mode === 'restricted' && user.role !== 'ADMIN' });
    }
    if (p === '/api/admin/settings/member-visibility' && request.method() === 'PUT') {
      const body = request.postDataJSON() as { mode: 'open' | 'restricted' };
      puts.push(body);
      state.mode = body.mode;
      return json({ mode: body.mode, restrictedForMe: false });
    }
    if (p === '/api/users/me/onboarding-state') return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p === '/api/users/me') {
      if (setup.meDelay) await new Promise((r) => setTimeout(r, setup.meDelay));
      return json(user);
    }
    if (p === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: user.role, joinedAt: '2026-01-01' }]);
    if (p === '/api/license/status') return json({ plan: 'team', status: 'active' });
    if (p === '/api/mcp-servers') {
      if (state.serversFailures > 0) {
        state.serversFailures--;
        return json({ statusCode: 500, message: 'Internal server error' }, 500);
      }
      return json(setup.servers ?? []);
    }
    // One server: hers, or the 404 of an unknown id (also for another member's).
    const serverId = /^\/api\/mcp-servers\/([^/]+)$/.exec(p)?.[1];
    if (serverId) {
      const own = (setup.servers as Array<{ id: string }> | undefined)?.find((x) => x.id === serverId);
      return own ? json(own) : json({ statusCode: 404, message: 'MCP server not found', error: 'Not Found' }, 404);
    }
    if (p === '/api/license/usage' && setup.usage) return json(setup.usage);
    if (p === '/api/memory/status') {
      return json({
        licensed: false,
        access: 'none',
        isCurator: false,
        settings: { defaultAccess: 'none', writeMode: 'approval' },
        ...setup.memory,
      });
    }
    if (p === '/api/connectors') return json(setup.connectors ?? []);
    const byId = /^\/api\/connectors\/([^/]+)$/.exec(p);
    const row = byId && setup.connectors?.find((c) => c.id === byId[1]);
    if (row) return json(row);
    if (p === '/api/audit/stats') return json({ invocations24h: 0, errors24h: 0 });
    if (p === '/api/audit/analytics') {
      return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    }
    // The Analytics page reads `rates` as soon as this answer arrives: with
    // the catch-all `{}` below the page ended on its error boundary, and a
    // test that goes to /analytics passed only while that answer was late.
    if (p === '/api/audit/breakdowns') {
      return json({
        days: 30,
        total: 0,
        errors: 0,
        proxyCalls: 0,
        estCostMicros: 0,
        rates: { callMicros: 0, proxyCallMicros: 0 },
        byConnector: [],
        byServer: [],
        byUser: [],
      });
    }
    if (p === '/api/audit/tool-performance') return json({ items: [], hasMore: false });
    // What the API answers a member who is not an admin.
    if (user.role !== 'ADMIN' && ADMIN_ONLY_CALLS.test(p) && p !== '/api/adapters') {
      return json({ statusCode: 403, message: 'Forbidden' }, 403);
    }
    if (p === '/api/roles') return json(setup.roles ?? []);
    if (p === '/api/users') return json(setup.members ?? []);
    if (p === '/api/users/invitations') return json([]);
    if (p === '/api/adapters' || p === '/api/adapters/popular-connectors' || p === '/api/adapters/starter-pack') {
      return json([]);
    }
    return json({});
  });
  return { puts, paths };
}

/** A signed-in session whose identity is set again on every page load. */
async function fakeSession(page: Page, setup: Setup) {
  const user = userFor(setup);
  await page.context().addCookies([
    { name: 'amcp_token', value: 't', url: BASE_URL },
    // What her earlier loads left in this browser (lib/member-access.ts).
    ...(setup.mode === 'restricted' && setup.role !== 'ADMIN' && !setup.firstVisit
      ? [{ name: 'amcp_nav', value: 'restricted', url: BASE_URL }]
      : []),
  ]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
    // Whether a page that is not the member's was ever drawn, even for a moment.
    const seen = new Set<string>();
    (window as unknown as { __seen: Set<string> }).__seen = seen;
    const check = () => {
      const text = document.body?.innerText ?? '';
      for (const marker of ['Access Denied', 'Invite User', 'Forbidden']) {
        if (text.includes(marker)) seen.add(marker);
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener('DOMContentLoaded', check);
  }, user);
  return mockApi(page, setup, () => user);
}

const sidebar = (page: Page) => page.getByTestId('app-nav').getByRole('link');
const settingsNav = (page: Page) => page.getByTestId('settings-nav').getByRole('link');
const seen = (page: Page) => page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen]);

const FULL_NAV = [
  'Dashboard',
  'Analytics',
  'Audit Log',
  'Connectors',
  'Marketplace',
  'MCP Servers',
  'Knowledge Graph',
  'AI Skills',
  'Memory',
  'Learning projects',
  'Setup & onboarding',
];

test.describe('restricted VIEWER', () => {
  test('the sidebar lists only what she can use', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);
    // No group is left behind with nothing in it.
    await expect(page.getByTestId('app-nav')).not.toContainText('Intelligence');
    await expect(page.getByTestId('app-nav')).not.toContainText('Get started');
    // Settings stays: her profile and her connections live there.
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    // The catalog installs connectors, which a viewer cannot.
    await expect(page.getByRole('link', { name: /Adapters|Marketplace/ })).toHaveCount(0);
  });

  test('MCP Servers is listed only when she owns one, Memory only when an admin gave her access', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [] });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors']);

    await page.goto('/mcp-server');
    await expect(page).toHaveURL(/\/connectors$/);
  });

  test('Memory is listed and opens when her memory access allows it', async ({ page }) => {
    await fakeSession(page, {
      role: 'VIEWER',
      mode: 'restricted',
      servers: [OWN_SERVER],
      memory: { licensed: true, access: 'personal', isCurator: false },
    });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers', 'Memory']);
    await page.goto('/memory');
    await expect(page).toHaveURL(/\/memory$/);
  });

  for (const path of [
    '/settings/users',
    '/settings/roles',
    '/settings/identity-providers',
    '/settings/admin',
    '/settings/license',
    '/admin/users',
    '/connectors/store',
    '/connectors/new',
    '/connectors/setup/todoist',
    '/knowledge-graph',
    '/knowledge-graph/skills',
    '/knowledge-graph/learning',
    '/memory',
    '/welcome',
  ]) {
    test(`a direct URL to ${path} lands on the connectors list, undrawn and unasked`, async ({ page }) => {
      const { paths } = await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
      await page.goto(path);

      await expect(page).toHaveURL(/\/connectors$/);
      await expect(page.getByText('This page is not available to you', { exact: true })).toBeVisible();
      await expect(page.getByTestId('nothing-shared')).toBeVisible();
      // The page itself never appeared, not even its refusal.
      expect(await seen(page)).toEqual([]);
      // And none of its requests left the browser.
      expect(paths.filter((p) => ADMIN_ONLY_CALLS.test(p))).toEqual([]);
    });
  }

  test('her very first load in a browser ends narrow too, and leaves the hint for the next one', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER], firstVisit: true });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);
    await expect
      .poll(async () => (await page.context().cookies(BASE_URL)).find((c) => c.name === 'amcp_nav')?.value)
      .toBe('restricted');
  });

  test('on her very first load a direct URL still lands on the connectors list', async ({ page }) => {
    // Without the hint the page is sent as for anyone; she is redirected as
    // soon as her answer has loaded.
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER], firstVisit: true });
    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/connectors$/);
    await expect(page.getByText('This page is not available to you', { exact: true })).toBeVisible();
  });

  test('opening the same refused page twice without a page load redirects twice', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);

    // A client-side navigation, as a link inside the dashboard makes it (a
    // plan banner links to /settings/license): no page load in between.
    const openLicencePage = () =>
      page.evaluate(() => {
        window.history.pushState(null, '', '/settings/license');
      });
    let loads = 0;
    page.on('load', () => loads++);

    await openLicencePage();
    await expect(page).toHaveURL(/\/connectors$/);
    await expect(page.getByTestId('nothing-shared')).toBeVisible();

    // The second time used to leave the page blank: nothing rendered, no redirect.
    await openLicencePage();
    await expect(page).toHaveURL(/\/connectors$/);
    await expect(page.getByTestId('nothing-shared')).toBeVisible();
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);
    expect(loads).toBe(0);
  });

  test('a failed request for her servers hides nothing and refuses nothing, and is asked again', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER], serversFailures: 1 });
    await page.goto('/connectors');
    // Not known is not "no": the entry stays, and the page opens.
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);
    await sidebar(page).filter({ hasText: 'MCP Servers' }).click();
    await expect(page).toHaveURL(/\/mcp-server$/);
    await expect(page.getByText('Default (Rita)')).toBeVisible();
  });

  test('after a failed request the next page asks again and then follows the answer', async ({ page }) => {
    // She owns no server; the first request for the list fails.
    const { paths } = await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [], serversFailures: 1 });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);

    await sidebar(page).filter({ hasText: 'Analytics' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors']);
    expect(paths.filter((x) => x === '/api/mcp-servers').length).toBeGreaterThanOrEqual(2);
    // The page itself has loaded its data and still stands.
    await expect.poll(() => paths.includes('/api/audit/breakdowns')).toBe(true);
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors']);
  });

  test('another member\'s MCP server sends her back to her own list, with the same note', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/mcp-server/s-of-someone-else');
    await expect(page).toHaveURL(/\/mcp-server$/);
    await expect(page.getByText('This page is not available to you', { exact: true })).toBeVisible();
    await expect(page.getByText('Default (Rita)')).toBeVisible();
    await expect(page.getByText('MCP server not found')).toHaveCount(0);
  });

  test('a File Search hand-off that cannot be opened sends her to her connectors', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/setup/file-search');
    await expect(page).toHaveURL(/\/connectors$/);
    await expect(page.getByText('This page is not available to you', { exact: true })).toBeVisible();
    await expect(page.getByText('The folder setup could not be opened')).toHaveCount(0);
  });

  test('the settings navigation and the command palette follow the same rule', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/settings');
    await expect(settingsNav(page)).toHaveCount(4);
    await expect(settingsNav(page)).toContainText(['Profile', 'Connections', 'General', 'File Share']);

    await page.getByRole('button', { name: /search|open command palette/i }).first().click();
    const palette = page.getByRole('listbox', { name: 'Commands' });
    await expect(palette.getByRole('option', { name: /Connectors/ }).first()).toBeVisible();
    for (const hidden of ['Marketplace', 'Knowledge Graph', 'AI Skills', 'Memory', 'Learning projects', 'Setup & onboarding', 'Users', 'Roles', 'Add connector']) {
      await expect(palette.getByRole('option', { name: new RegExp(hidden) })).toHaveCount(0);
    }
    await expect(palette.getByRole('option', { name: /Default \(Rita\)/ })).toBeVisible();
  });

  test('the dashboard offers nothing she cannot open and does not ask for the graph', async ({ page }) => {
    const { paths } = await fakeSession(page, {
      role: 'VIEWER',
      mode: 'restricted',
      servers: [OWN_SERVER],
      connectors: [{ id: 'c1', name: 'Ledger', type: 'REST', isActive: true, memberView: true, tools: [] }],
    });
    await page.goto('/');
    await expect(page.getByText('Quick actions')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configure a client' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New connector' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add a connector' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Explore the graph' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ledger' })).toBeVisible();
    expect(paths.filter((p) => p.startsWith('/api/knowledge-graph'))).toEqual([]);
  });

  test('Settings → Organization: no feature switches, and no workspace to create on a self-hosted instance', async ({ page }) => {
    const { paths } = await fakeSession(page, { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] });
    await page.goto('/settings/organization');
    await expect(page.getByText('Your Role', { exact: true })).toBeVisible();
    await expect(page.getByText('My Organizations')).toBeVisible();
    await expect(page.getByTestId('create-org')).toHaveCount(0);
    await expect(page.getByTestId('create-org-admin-only')).toHaveText('Only admins can create a workspace on this instance.');
    await expect(page.getByText('Features', { exact: true })).toHaveCount(0);
    expect(paths.filter((p) => p.startsWith('/api/knowledge-graph'))).toEqual([]);
  });
});

/**
 * What the server sends before any script runs, read with JavaScript off.
 * It knows the member only through the hint cookie the dashboard left on an
 * earlier load (lib/member-access.ts). With the cookie it renders her narrow
 * navigation and nothing of a guarded page. Without it, which is everyone but
 * a restricted member, it renders exactly what it always did.
 */
test.describe('the server-rendered page', () => {
  async function withoutScripts(browser: Browser, hint: 'restricted' | null) {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.addCookies([
      { name: 'amcp_token', value: 't', url: BASE_URL },
      ...(hint ? [{ name: 'amcp_nav', value: hint, url: BASE_URL }] : []),
    ]);
    return { context, page: await context.newPage() };
  }

  test('with the hint: the narrow navigation, and nothing of a guarded page', async ({ browser }) => {
    const { context, page } = await withoutScripts(browser, 'restricted');
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors']);

    await page.goto('/settings/users');
    await expect(page.getByTestId('app-nav')).toHaveCount(0);
    await expect(page.getByText('Access Denied')).toHaveCount(0);
    await page.goto('/mcp-server');
    await expect(page.getByTestId('app-nav')).toHaveCount(0);
    await context.close();
  });

  test('without the hint: the whole navigation and every page, as before', async ({ browser }) => {
    const { context, page } = await withoutScripts(browser, null);
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(FULL_NAV);
    // Guarded pages are sent as they always were: their shell is not withheld.
    for (const path of ['/settings/users', '/mcp-server', '/settings/license']) {
      await page.goto(path);
      await expect(sidebar(page)).toHaveText(FULL_NAV);
    }
    await context.close();
  });
});

/**
 * The server renders from the hint cookie and the browser takes over with the
 * same value, before it knows who is signed in: the two must draw the same
 * page, or React reports a hydration mismatch and redraws it.
 */
test.describe('hydration', () => {
  for (const [name, setup, path] of [
    ['a restricted viewer with the hint', { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] }, '/connectors'],
    ['a restricted viewer with the hint, on a refused page', { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER] }, '/settings/users'],
    ['a restricted viewer on her first visit', { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER], firstVisit: true }, '/connectors'],
    ['an admin', { role: 'ADMIN', mode: 'restricted', roles: [], members: [] }, '/settings/users'],
    ['a member of an open workspace', { role: 'EDITOR', mode: 'open' }, '/connectors/store'],
  ] as Array<[string, Setup, string]>) {
    test(`${name}: the browser takes over what the server drew`, async ({ page }) => {
      const problems: string[] = [];
      page.on('console', (message) => {
        if (/hydrat|did not match|didn't match/i.test(message.text())) problems.push(message.text().slice(0, 200));
      });
      page.on('pageerror', (error) => {
        if (/hydrat/i.test(error.message)) problems.push(error.message.slice(0, 200));
      });
      await fakeSession(page, setup);
      await page.goto(path);
      await expect(page.getByTestId('app-nav')).toBeVisible();
      await page.waitForTimeout(500);
      expect(problems).toEqual([]);
    });
  }
});

test.describe('restricted EDITOR', () => {
  test('keeps what creates connectors and servers, loses the pages about other members\' work', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'restricted', servers: [] });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'Marketplace', 'MCP Servers']);

    await page.goto('/connectors/new');
    await expect(page).toHaveURL(/\/connectors\/new$/);
    await expect(page.getByText('Choose connector type')).toBeVisible();

    await page.goto('/connectors/store');
    await expect(page).toHaveURL(/\/connectors\/store$/);

    for (const path of ['/knowledge-graph', '/knowledge-graph/skills', '/settings/users', '/welcome']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/connectors$/);
    }
  });

  test('keeps the File Search hand-off page, whose wizard she may open', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'restricted' });
    await page.goto('/setup/file-search');
    await expect(page).toHaveURL(/\/setup\/file-search$/);
    await expect(page.getByText('The folder setup could not be opened')).toBeVisible();
  });

  test('cannot create a workspace on a self-hosted instance either', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'restricted' });
    await page.goto('/settings/organization');
    await expect(page.getByText('My Organizations')).toBeVisible();
    await expect(page.getByTestId('create-org')).toHaveCount(0);
  });
});

test.describe('unchanged for everyone else', () => {
  test('an admin of a restricted workspace keeps the whole navigation and every page', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'restricted', servers: [OWN_SERVER], roles: [], members: [] });
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(FULL_NAV);
    // The hint exists only for a restricted member.
    await page.waitForTimeout(300);
    expect((await page.context().cookies(BASE_URL)).some((c) => c.name === 'amcp_nav')).toBe(false);

    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/settings\/users$/);
    await expect(page.getByRole('button', { name: 'Invite User' })).toBeVisible();
    await expect(settingsNav(page)).toContainText(['Users', 'Roles', 'Single sign-on', 'License', 'Administration']);

    await page.goto('/settings/organization');
    await expect(page.getByTestId('create-org')).toBeVisible();
    await expect(page.getByText('Features', { exact: true })).toBeVisible();
  });

  test.describe('open workspace', () => {
    for (const role of ['VIEWER', 'EDITOR'] as const) {
      test(`a ${role} keeps the whole navigation, and a page of admins answers as before`, async ({ page }) => {
        await fakeSession(page, { role, mode: 'open' });
        await page.goto('/connectors');
        await expect(sidebar(page)).toHaveText(FULL_NAV);

        await page.goto('/knowledge-graph');
        await expect(page).toHaveURL(/\/knowledge-graph$/);
        await page.goto('/connectors/store');
        await expect(page).toHaveURL(/\/connectors\/store$/);
        // Not redirected: the page's own "Access Denied", as today.
        await page.goto('/settings/users');
        await expect(page).toHaveURL(/\/settings\/users$/);
        await expect(page.getByRole('heading', { name: 'Access Denied' })).toBeVisible();
      });
    }
  });

  test('an admin signing in clears a hint a restricted member left in the browser', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'restricted', servers: [OWN_SERVER] });
    await page.context().addCookies([{ name: 'amcp_nav', value: 'restricted', url: BASE_URL }]);
    await page.goto('/connectors');
    await expect(sidebar(page)).toHaveText(FULL_NAV);
    await expect
      .poll(async () => (await page.context().cookies(BASE_URL)).some((c) => c.name === 'amcp_nav'))
      .toBe(false);
  });

  test('the dashboard loads its data without waiting for the profile request', async ({ page }) => {
    const { paths } = await fakeSession(page, { role: 'ADMIN', mode: 'open', meDelay: 4000 });
    await page.goto('/');
    // Asked for while GET /api/users/me is still on its way.
    await expect.poll(() => paths.includes('/api/audit/stats'), { timeout: 2500 }).toBe(true);
    expect(paths.includes('/api/connectors')).toBe(true);
  });

  test('Cloud: every member may still create their own workspace', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', deploymentMode: 'cloud', servers: [OWN_SERVER] });
    await page.goto('/settings/organization');
    await expect(page.getByTestId('create-org')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Organization' })).toBeVisible();
    await expect(page.getByTestId('create-org-admin-only')).toHaveCount(0);
  });
});

test.describe('the member visibility setting', () => {
  test('says which mode is active, that a choice is not saved, and asks before the page is left', async ({ page }) => {
    const { puts } = await fakeSession(page, { role: 'ADMIN', mode: 'open', roles: [] });
    await page.goto('/settings/organization');
    const section = page.getByTestId('member-visibility');
    await expect(page.getByTestId('member-visibility-active')).toHaveText('Active now: Open');
    await expect(page.getByTestId('member-visibility-unsaved')).toHaveCount(0);

    await section.getByRole('radio', { name: /^Restricted/ }).check();
    // Still Open, and it says so.
    await expect(page.getByTestId('member-visibility-active')).toHaveText('Active now: Open');
    await expect(page.getByTestId('member-visibility-unsaved')).toHaveText(
      'Not saved yet. This workspace is still Open: every member sees everything until you save.',
    );
    await expect(page.getByTestId('member-visibility-no-tool-list')).toContainText(
      'Restricted does not narrow which connectors members see yet.',
    );
    expect(puts).toEqual([]);

    // Leaving with the choice unsaved is not silent.
    const asked = page.waitForEvent('dialog');
    // Not awaited: the call returns only once the dialog is answered.
    const leaving = page
      .evaluate(() => {
        window.location.reload();
      })
      .catch(() => undefined);
    const dialog = await asked;
    expect(dialog.type()).toBe('beforeunload');
    // Stay on the page.
    await dialog.dismiss();
    await leaving;

    // A link inside the dashboard asks too: no page load, so no browser prompt.
    const asksOnLink = page.waitForEvent('dialog');
    const click = sidebar(page).filter({ hasText: 'Connectors' }).click();
    const confirm = await asksOnLink;
    expect(confirm.type()).toBe('confirm');
    expect(confirm.message()).toBe('The member visibility you chose is not saved yet. Leave this page without saving?');
    await confirm.dismiss();
    await click;
    await expect(page).toHaveURL(/\/settings\/organization$/);
    await expect(page.getByTestId('member-visibility-unsaved')).toBeVisible();

    // Discard puts the saved mode back; nothing was written.
    await section.getByRole('button', { name: 'Discard' }).click();
    await expect(section.getByRole('radio', { name: /^Open/ })).toBeChecked();
    await expect(page.getByTestId('member-visibility-unsaved')).toHaveCount(0);

    await section.getByRole('radio', { name: /^Restricted/ }).check();
    await section.getByRole('button', { name: 'Save: switch to Restricted' }).click();
    await expect(page.getByTestId('member-visibility-active')).toHaveText('Active now: Restricted');
    await expect(page.getByTestId('member-visibility-unsaved')).toHaveCount(0);
    expect(puts).toEqual([{ mode: 'restricted' }]);
    // Saved and still without any tool list: the notice stays.
    await expect(page.getByTestId('member-visibility-no-tool-list')).toBeVisible();

    // Nothing unsaved any more: a link just leaves.
    await sidebar(page).filter({ hasText: 'Connectors' }).click();
    await expect(page).toHaveURL(/\/connectors$/);
  });

  test('leaving through a link is possible after confirming', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'open', roles: [] });
    await page.goto('/settings/organization');
    await page.getByTestId('member-visibility').getByRole('radio', { name: /^Restricted/ }).check();
    page.once('dialog', (dialog) => void dialog.accept());
    await sidebar(page).filter({ hasText: 'Connectors' }).click();
    await expect(page).toHaveURL(/\/connectors$/);
  });

  test('the invite form offers Viewer first in a restricted workspace, Editor in an open one', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'restricted', roles: [], members: [] });
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Invite User' }).click();
    await expect(page.getByTestId('invite-role-hint')).toContainText('A Viewer sees only what their MCP roles reach.');
    await expect(page.getByText('App Role').locator('..')).toContainText('VIEWER');
  });

  test('the invite form keeps Editor first in an open workspace', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'open', roles: [], members: [] });
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Invite User' }).click();
    await expect(page.getByTestId('invite-role-hint')).toHaveCount(0);
    await expect(page.getByText('App Role').locator('..')).toContainText('EDITOR');
  });
});

test.describe('connector owners', () => {
  const connectors = [
    { id: 'c1', userId: 'u2', organizationId: 'o1', name: 'Ledger', type: 'REST', baseUrl: 'https://ledger.example.test', authType: 'NONE', isActive: true, tools: [] },
    { id: 'c2', userId: 'u-gone', organizationId: 'o1', name: 'Archive', type: 'REST', baseUrl: 'https://archive.example.test', authType: 'NONE', isActive: true, tools: [] },
  ];
  const members = [
    { id: 'u1', email: 'rita@example.test', name: 'Rita', role: 'ADMIN' },
    { id: 'u2', email: 'paul@example.test', name: 'Paul', role: 'VIEWER' },
  ];

  test('an admin sees who owns each connector, also when the owner has left', async ({ page }) => {
    await fakeSession(page, { role: 'ADMIN', mode: 'restricted', connectors, members });
    await page.goto('/connectors');
    await expect(page.getByTestId('connector-owner')).toHaveText(['Owner: Paul', 'Owner: no longer a member']);
  });

  test('a workspace with one active member shows no owner line', async ({ page }) => {
    const alone = [
      { id: 'u1', email: 'rita@example.test', name: 'Rita', role: 'ADMIN', active: true, deactivatedAt: null },
      { id: 'u2', email: 'paul@example.test', name: 'Paul', role: 'VIEWER', active: false, deactivatedAt: '2026-10-01T00:00:00Z' },
    ];
    await fakeSession(page, { role: 'ADMIN', mode: 'open', connectors, members: alone });
    await page.goto('/connectors');
    await expect(page.getByText('https://ledger.example.test')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('connector-owner')).toHaveCount(0);
  });

  test('Cloud, one member: no owner line and no request for the members list', async ({ page }) => {
    const usage = (users: number) => ({
      plan: 'team',
      connectors: { current: 2, max: 50, isOver: false },
      mcpServers: { current: 1, max: 10, isOver: false },
      users: { current: users, max: 5, isOver: false },
      isOverAny: false,
    });
    const { paths } = await fakeSession(page, {
      role: 'ADMIN',
      mode: 'open',
      deploymentMode: 'cloud',
      connectors,
      members,
      usage: usage(1),
    });
    await page.goto('/connectors');
    await expect(page.getByText('https://ledger.example.test')).toBeVisible();
    await expect.poll(() => paths.includes('/api/license/usage')).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('connector-owner')).toHaveCount(0);
    expect(paths).not.toContain('/api/users');
  });

  test('Cloud, several members: the owner lines, from one request', async ({ page }) => {
    const { paths } = await fakeSession(page, {
      role: 'ADMIN',
      mode: 'open',
      deploymentMode: 'cloud',
      connectors,
      members,
      usage: {
        plan: 'team',
        connectors: { current: 2, max: 50, isOver: false },
        mcpServers: { current: 1, max: 10, isOver: false },
        users: { current: 2, max: 5, isOver: false },
        isOverAny: false,
      },
    });
    await page.goto('/connectors');
    await expect(page.getByTestId('connector-owner')).toHaveText(['Owner: Paul', 'Owner: no longer a member']);
    expect(paths.filter((x) => x === '/api/users')).toHaveLength(1);
  });

  test('a member is not shown owners and the members list is not asked for', async ({ page }) => {
    const { paths } = await fakeSession(page, { role: 'EDITOR', mode: 'open', connectors, members });
    await page.goto('/connectors');
    await expect(page.getByText('https://ledger.example.test')).toBeVisible();
    await expect(page.getByTestId('connector-owner')).toHaveCount(0);
    expect(paths).not.toContain('/api/users');
  });
});

test.describe('two accounts in one browser', () => {
  const admin = { id: 'u-admin', email: 'alex@example.test', name: 'Alex', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
  const viewer = { id: 'u-rita', email: 'rita@example.test', name: 'Rita', role: 'VIEWER', organizationId: 'o1', emailVerified: true };

  /** A tab whose session is whatever localStorage holds, as in a real browser. */
  async function openTab(context: BrowserContext) {
    const page = await context.newPage();
    await mockApi(
      page,
      { role: 'VIEWER', mode: 'restricted', servers: [OWN_SERVER], connectors: [] },
      // Answer for whoever the tab last sent (the mocked token names nobody).
      () => currentUser as ReturnType<typeof userFor>,
    );
    return page;
  }
  let currentUser: typeof admin | typeof viewer = admin;

  test('a tab follows a sign-in made in another tab instead of showing the old account', async ({ context }) => {
    currentUser = admin;
    await context.addCookies([{ name: 'amcp_token', value: 't', url: BASE_URL }]);
    const first = await openTab(context);
    await first.goto('/login');
    await first.evaluate((u) => {
      localStorage.setItem('amcp_token', 't-admin');
      localStorage.setItem('amcp_user', JSON.stringify(u));
    }, admin);
    await first.goto('/connectors');
    await expect(first.getByText('alex@example.test')).toBeVisible();
    await expect(sidebar(first)).toHaveText(FULL_NAV);

    // The other tab signs in as a restricted viewer: same storage, new identity.
    const second = await openTab(context);
    await second.goto('/login');
    currentUser = viewer;
    const reloaded = first.waitForEvent('load');
    await second.evaluate((u) => {
      localStorage.setItem('amcp_token', 't-rita');
      localStorage.setItem('amcp_user', JSON.stringify(u));
    }, viewer);
    await reloaded;

    // The first tab is now that account, with that account's navigation.
    await expect(first.getByText('rita@example.test')).toBeVisible();
    await expect(first.getByText('alex@example.test')).toHaveCount(0);
    await expect(sidebar(first)).toHaveText(['Dashboard', 'Analytics', 'Audit Log', 'Connectors', 'MCP Servers']);
  });

  test('a tab is not reloaded when the other tab only refreshes the same account', async ({ context }) => {
    currentUser = admin;
    await context.addCookies([{ name: 'amcp_token', value: 't', url: BASE_URL }]);
    const first = await openTab(context);
    await first.goto('/login');
    await first.evaluate((u) => {
      localStorage.setItem('amcp_token', 't-admin');
      localStorage.setItem('amcp_user', JSON.stringify(u));
    }, admin);
    await first.goto('/connectors');
    await expect(first.getByText('alex@example.test')).toBeVisible();
    let loads = 0;
    first.on('load', () => loads++);

    const second = await openTab(context);
    await second.goto('/login');
    await second.evaluate((u) => {
      localStorage.setItem('amcp_user', JSON.stringify({ ...u, name: 'Alex A.' }));
    }, admin);
    await second.waitForTimeout(800);
    expect(loads).toBe(0);
  });
});
