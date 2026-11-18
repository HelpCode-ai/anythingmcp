import { expect, test, type Page } from '@playwright/test';

/**
 * Settings → Roles → User MCP Role Assignment.
 * The table used to show the deprecated single `mcpRoleId`, so a role granted
 * by a single sign-on group (and widening access) was invisible.
 */

const USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const MEMBERS = [
  { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'ADMIN', active: true, roles: [], connectors: null },
  {
    id: 'u2',
    email: 'ana@example.com',
    name: 'Ana',
    role: 'VIEWER',
    active: true,
    roles: [
      { roleId: 'r1', roleName: 'Sales', source: 'manual', global: false },
      { roleId: 'r2', roleName: 'Finance', source: 'entra', global: false },
      { roleId: 'r9', roleName: 'Everywhere', source: 'manual', global: true },
    ],
    connectors: [
      { id: 'c1', name: 'CRM' },
      { id: 'c2', name: 'ERP' },
    ],
  },
  { id: 'u3', email: 'bo@example.com', name: null, role: 'EDITOR', active: true, roles: [], connectors: [] },
];

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
      return json({ message: 'Roles updated' });
    }
    if (url.pathname === '/api/roles') {
      return json([
        { id: 'r1', name: 'Sales', description: null, isSystem: false, _count: { users: 1, toolAccess: 1 } },
        { id: 'r2', name: 'Finance', description: null, isSystem: false, _count: { users: 1, toolAccess: 1 } },
        { id: 'r3', name: 'Support', description: null, isSystem: false, _count: { users: 0, toolAccess: 1 } },
      ]);
    }
    if (url.pathname === '/api/roles/members') return json(MEMBERS);
    if (url.pathname === '/api/connectors') return json([]);
    if (url.pathname.startsWith('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.pathname === '/api/users/me') return json(USER);
    if (url.pathname === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.pathname === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.pathname === '/api/license/status') return json({ plan: 'team', status: 'active' });
    return json({});
  });

  await page.goto('/settings/roles');
  await expect(page.getByTestId('roles-union-hint')).toBeVisible();
  return puts;
}

test.describe('member MCP role assignments', () => {
  test('shows every role of a member, with where it comes from', async ({ page }) => {
    await openRoles(page);

    const ana = page.getByTestId('member-ana@example.com');
    const chips = ana.getByTestId('mcp-role-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.filter({ hasText: 'Sales' })).not.toContainText('single sign-on');
    await expect(chips.filter({ hasText: 'Finance' })).toContainText('from single sign-on group');
    await expect(chips.filter({ hasText: 'Everywhere' })).toContainText('all workspaces');
    await expect(ana.getByRole('link', { name: 'Settings → Single sign-on → Role mappings' })).toHaveAttribute(
      'href',
      '/settings/identity-providers',
    );
    await expect(ana.getByText('2 connectors')).toBeVisible();

    await expect(page.getByTestId('member-admin@example.com')).toContainText('Full access (admin)');
    const bo = page.getByTestId('member-bo@example.com');
    await expect(bo).toContainText('No role, so no tools.');
    // No single sign-on role, so no hint about changing one.
    await expect(bo.getByRole('link', { name: /Role mappings/ })).toHaveCount(0);
  });

  test('saves only the manual roles', async ({ page }) => {
    const puts = await openRoles(page);

    const ana = page.getByTestId('member-ana@example.com');
    // The picker lists the manual roles of this workspace only.
    await ana.getByRole('button', { name: 'Sales' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Support' }).click();
    await page.keyboard.press('Escape');
    await ana.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toEqual({ url: '/api/roles/assignments/u2', body: { roleIds: ['r1', 'r3'] } });
    await expect(page.getByText('MCP roles saved')).toBeVisible();
  });
});
