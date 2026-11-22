import { expect, test, type Page } from '@playwright/test';

/**
 * Member visibility (Settings → Organization → Security). An admin switches
 * the mode; a member whose workspace is restricted sees a note on Logs and
 * Analytics, no "by user" panel, an empty state on Connectors and MCP
 * Servers, and is not sent into the setup wizard. An open workspace shows
 * none of it. A connector shared with a restricted member arrives in a
 * reduced view (`memberView`): the pages show its name, status and tools, no
 * settings, and no control that writes. In every mode the write controls are
 * shown to the owner or an admin only. The API is mocked, as in the other
 * smoke tests.
 */

const BASE_URL = 'http://localhost:3100';

type Role = 'ADMIN' | 'EDITOR' | 'VIEWER';

interface Setup {
  role: Role;
  mode: 'open' | 'restricted';
  /** Roles returned by /api/roles (admin only). */
  roles?: unknown[];
  /** Delay of the member visibility answer, in ms. */
  visibilityDelay?: number;
  onboardingDone?: boolean;
  /** Rows of GET /api/connectors; each is also served at /api/connectors/<id>. */
  connectors?: Array<{ id: string } & Record<string, unknown>>;
}

function userFor(role: Role) {
  return { id: 'u1', email: 'member@example.test', name: 'Member', role, organizationId: 'o1', emailVerified: true };
}

async function fakeSession(page: Page, setup: Setup) {
  const user = userFor(setup.role);
  const state = { mode: setup.mode };
  const puts: unknown[] = [];
  /** Every API path the page asked for. */
  const paths: string[] = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: BASE_URL }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);
  await page.route(/\/(api|health)\//, async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    paths.push(p);
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/health/server-info') {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'oauth2', hasUsers: true, ssoProviders: [] });
    }
    if (p === '/api/settings/member-visibility') {
      if (setup.visibilityDelay) await new Promise((r) => setTimeout(r, setup.visibilityDelay));
      return json({ mode: state.mode, restrictedForMe: state.mode === 'restricted' && setup.role !== 'ADMIN' });
    }
    if (p === '/api/admin/settings/member-visibility' && request.method() === 'PUT') {
      const body = request.postDataJSON() as { mode: 'open' | 'restricted' };
      puts.push(body);
      state.mode = body.mode;
      return json({ mode: body.mode, restrictedForMe: false });
    }
    if (p === '/api/roles') return json(setup.roles ?? []);
    if (p === '/api/users/me/onboarding-state') {
      return json({ onboardingCompletedAt: setup.onboardingDone === false ? null : '2026-01-01T00:00:00Z' });
    }
    if (p === '/api/users/me') return json(user);
    if (p === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: setup.role, joinedAt: '2026-01-01' }]);
    if (p === '/api/license/status') return json({ plan: 'community', status: 'active' });
    if (p === '/api/adapters/starter-pack') return json([]);
    if (p === '/api/connectors') return json(setup.connectors ?? []);
    const byId = /^\/api\/connectors\/([^/]+)$/.exec(p);
    const row = byId && setup.connectors?.find((c) => c.id === byId[1]);
    if (row) return json(row);
    if (p === '/api/mcp-servers') return json([]);
    if (p === '/api/audit/invocations') return json([]);
    if (p === '/api/audit/stats') return json({ invocations24h: 0, errors24h: 0 });
    if (p === '/api/audit/analytics') {
      return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    }
    if (p === '/api/audit/breakdowns') {
      return json({
        days: 30, total: 3, errors: 0, proxyCalls: 0, estCostMicros: 0,
        rates: { callMicros: 0, proxyCallMicros: 0 },
        byConnector: [], byServer: [], byUser: [{ id: 'u1', label: 'member@example.test', count: 3, errors: 0 }],
      });
    }
    if (p === '/api/audit/tool-performance') return json({ items: [], hasMore: false });
    return json({});
  });
  return { puts, paths };
}

/** What a restricted member gets of a connector they may use but do not own. */
const REDUCED_CONNECTOR = {
  id: 'c1',
  name: 'Ledger',
  type: 'DATABASE',
  icon: null,
  isActive: true,
  credentialScope: 'USER',
  setupStatus: 'ready',
  authStatus: null,
  authStatusCode: null,
  memberView: true,
  tools: [{ id: 't1', name: 'ledger_list', description: 'Lists ledger entries', isEnabled: true }],
};

/** The same connector in full, owned by someone else, as an open workspace returns it. */
const FULL_CONNECTOR = {
  id: 'c1',
  userId: 'u2',
  organizationId: 'o1',
  name: 'Ledger',
  type: 'REST',
  baseUrl: 'https://ledger.example.test',
  authType: 'NONE',
  isActive: true,
  credentialScope: 'SHARED',
  envVars: { REGION: 'eu' },
  maskedEnvVars: [],
  headers: null,
  maskedHeaders: [],
  config: null,
  instructions: null,
  specUrl: null,
  setupStatus: 'ready',
  missingVariables: [],
  createdAt: '2026-01-01T00:00:00Z',
  tools: [
    {
      id: 't1',
      name: 'ledger_list',
      description: 'Lists ledger entries',
      isEnabled: true,
      parameters: { type: 'object', properties: {} },
      endpointMapping: { method: 'GET', path: '/entries' },
    },
  ],
};

/** The controls of the connector page that write. */
const WRITE_BUTTONS = ['Test', 'Edit', 'Delete', 'Import Tools', 'Add Tool', 'Disable', 'Hints'];

const OWN_CALLS = 'You see your own calls. Workspace admins see all calls.';
const NOTHING_SHARED = 'Nothing has been shared with you yet. Ask a workspace admin for a role.';
const NO_TOOL_LIST = /Restricted does not narrow which connectors members see yet/;

test.describe('admin control', () => {
  test('an admin sees the control, gets the warning without a tool list, and switches the mode', async ({ page }) => {
    const { puts } = await fakeSession(page, { role: 'ADMIN', mode: 'open', roles: [] });
    await page.goto('/settings/organization');

    const section = page.getByTestId('member-visibility');
    await expect(section.getByText('Member visibility', { exact: true })).toBeVisible();
    const open = section.getByRole('radio', { name: /^Open/ });
    const restricted = section.getByRole('radio', { name: /^Restricted/ });
    await expect(open).toBeChecked();
    await expect(section.getByText(NO_TOOL_LIST)).toHaveCount(0);

    await restricted.check();
    const warning = section.getByText(NO_TOOL_LIST);
    await expect(warning).toBeVisible();
    await expect(section.getByRole('link', { name: 'Roles' })).toHaveAttribute('href', '/settings/roles');

    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Member visibility saved.')).toBeVisible();
    expect(puts).toEqual([{ mode: 'restricted' }]);
    await expect(restricted).toBeChecked();
    await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('no warning when a role of the workspace has a tool list', async ({ page }) => {
    await fakeSession(page, {
      role: 'ADMIN',
      mode: 'restricted',
      roles: [{ id: 'r1', name: 'Sales', isSystem: false, organizationId: 'o1', _count: { users: 2, toolAccess: 3 } }],
    });
    await page.goto('/settings/organization');
    const section = page.getByTestId('member-visibility');
    await expect(section.getByRole('radio', { name: /^Restricted/ })).toBeChecked();
    await expect(section.getByText(NO_TOOL_LIST)).toHaveCount(0);
  });

  test('a member does not see the control', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'restricted' });
    await page.goto('/settings/organization');
    await expect(page.getByText('Your Role', { exact: true })).toBeVisible();
    await expect(page.getByTestId('member-visibility')).toHaveCount(0);
  });
});

test.describe('restricted member', () => {
  test('sees the note on Logs', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted' });
    await page.goto('/logs');
    await expect(page.getByText(OWN_CALLS)).toBeVisible();
  });

  test('sees the note and no "by user" panel on Analytics', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted' });
    await page.goto('/analytics');
    await expect(page.getByText(OWN_CALLS)).toBeVisible();
    await expect(page.getByText('Calls by MCP server', { exact: true })).toBeVisible();
    await expect(page.getByText('Calls by user', { exact: true })).toHaveCount(0);
  });

  test('sees the empty state on Connectors, without create actions as a VIEWER', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted' });
    await page.goto('/connectors');
    await expect(page.getByTestId('nothing-shared')).toContainText(NOTHING_SHARED);
    await expect(page.getByRole('link', { name: 'Add Connector' })).toHaveCount(0);

    // A VIEWER who owns no MCP server has no MCP Servers page: it would list
    // nothing and she cannot create one (restricted-navigation.spec.ts).
    await page.goto('/mcp-server');
    await expect(page).toHaveURL(/\/connectors$/);
  });

  test('sees the empty state on MCP Servers as an EDITOR, who may create one', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'restricted' });
    await page.goto('/mcp-server');
    await expect(page.getByTestId('nothing-shared')).toHaveText(NOTHING_SHARED);
    await expect(page.getByRole('button', { name: 'Create your first MCP Server' })).toBeVisible();
  });

  test('sees a shared connector in the reduced view: name, status and tools, nothing to change', async ({ page }) => {
    const { paths } = await fakeSession(page, { role: 'VIEWER', mode: 'restricted', connectors: [REDUCED_CONNECTOR] });
    await page.goto('/connectors');
    await expect(page.getByRole('link', { name: 'Ledger', exact: true })).toBeVisible();
    // No address to search in: the filter must still work.
    await page.getByLabel('Search connectors by name or URL').fill('led');
    await expect(page.getByRole('link', { name: 'Ledger', exact: true })).toBeVisible();
    await expect(page.getByText('Auth', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

    await page.goto('/connectors/c1');
    await expect(page.getByTestId('member-view-note')).toContainText('Shared with you');
    await expect(page.getByText('ledger_list', { exact: true })).toBeVisible();
    await expect(page.getByText('Lists ledger entries')).toBeVisible();
    // Per-user sign-in is the one thing a member does here.
    await expect(page.getByRole('button', { name: 'Connect my account' })).toBeVisible();
    for (const name of [...WRITE_BUTTONS, 'Export']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText('Connector Details', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Environment Variables', { exact: true })).toHaveCount(0);
    // Nothing is asked that the member may not read.
    expect(paths.filter((p) => /catalog-diff|oauth-config|webhook|file-search/.test(p))).toEqual([]);
  });

  test('is not sent to /welcome, even while the setting is still loading', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'restricted', onboardingDone: false, visibilityDelay: 1500 });
    await page.goto('/');
    await expect(page.getByText('Invocations · 24h')).toBeVisible();
    // Long enough for the onboarding check and the delayed setting to answer.
    await page.waitForTimeout(3000);
    await expect(page).not.toHaveURL(/\/welcome/);
  });
});

test.describe('open workspace', () => {
  test('a member sees no note, the "by user" panel and the usual empty states', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'open' });
    await page.goto('/logs');
    await expect(page.getByText('Tool invocation history across your connectors and MCP servers.')).toBeVisible();
    await expect(page.getByText(OWN_CALLS)).toHaveCount(0);

    await page.goto('/analytics');
    await expect(page.getByText('Calls by user', { exact: true })).toBeVisible();
    await expect(page.getByText(OWN_CALLS)).toHaveCount(0);

    await page.goto('/connectors');
    await expect(page.getByText('No connectors yet')).toBeVisible();
    await expect(page.getByText(NOTHING_SHARED)).toHaveCount(0);

    await page.goto('/mcp-server');
    await expect(page.getByText('No MCP servers configured yet.', { exact: false })).toBeVisible();
    await expect(page.getByText(NOTHING_SHARED)).toHaveCount(0);
  });

  test('a member who does not own a connector reads it in full, without the controls that write', async ({ page }) => {
    const { paths } = await fakeSession(page, { role: 'EDITOR', mode: 'open', connectors: [FULL_CONNECTOR] });
    await page.goto('/connectors');
    await expect(page.getByText('https://ledger.example.test')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import Spec', exact: true })).toHaveCount(0);

    await page.goto('/connectors/c1');
    await expect(page.getByText('https://ledger.example.test')).toBeVisible();
    await expect(page.getByText('Connector Details', { exact: true })).toBeVisible();
    await expect(page.getByText('ledger_list', { exact: true })).toBeVisible();
    await expect(page.getByTestId('member-view-note')).toHaveCount(0);
    // Exporting is a read every member of an open workspace has.
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    for (const name of WRITE_BUTTONS) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    expect(paths.filter((p) => /catalog-diff|webhook/.test(p))).toEqual([]);
  });

  test('the owner of a connector keeps every control', async ({ page }) => {
    await fakeSession(page, { role: 'EDITOR', mode: 'open', connectors: [{ ...FULL_CONNECTOR, userId: 'u1' }] });
    await page.goto('/connectors/c1');
    await expect(page.getByText('ledger_list', { exact: true })).toBeVisible();
    for (const name of ['Test', 'Edit', 'Export', 'Add Tool']) {
      await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
    }
  });

  test('a new member with no connectors is still sent to /welcome', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER', mode: 'open', onboardingDone: false });
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
  });
});
