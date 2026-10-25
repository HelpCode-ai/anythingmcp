import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Audit Log export (/logs): admins get an Export menu whose request carries
 * the filters and date range the page shows; other roles do not see it.
 * API calls are stubbed; the backend is covered by its own specs.
 */

// Fixed zone, so the local-midnight bounds the page sends are predictable.
test.use({ timezoneId: 'Europe/Berlin' });

const CSV =
  '﻿createdAt,status,tool\r\n2026-10-02T10:00:00.000Z,ERROR,search_customers\r\n' +
  '# truncated: this export stopped at 1 rows. Narrow the date range to export the rest.\r\n';

interface Session {
  role?: 'ADMIN' | 'EDITOR' | 'VIEWER';
  deploymentMode?: 'self-hosted' | 'cloud';
}

async function fakeSession(page: Page, { role = 'ADMIN', deploymentMode = 'self-hosted' }: Session = {}) {
  const user = {
    id: 'u1',
    email: 'test@example.com',
    name: 'Test User',
    role,
    organizationId: 'o1',
    emailVerified: true,
  };
  const listUrls: string[] = [];
  const exportUrls: string[] = [];

  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);

  await page.route(/\/(api|health)\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/health/server-info')) {
      return json({
        deploymentMode,
        mcpAuthMode: 'both',
        serverUrl: 'http://localhost:4000',
        mcpEndpoint: 'http://localhost:4000/mcp',
        hasUsers: true,
        registrationEnabled: true,
        ssoProviders: [],
      });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    // The auth context refreshes the user from here, so the role must match.
    if (url.includes('/api/users/me')) return json(user);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role, joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    if (url.includes('/api/mcp-servers')) return json([]);
    if (url.includes('/api/audit/invocations/export')) {
      exportUrls.push(url);
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="anythingmcp-audit-2026-09-30-2026-10-07.csv"',
        },
        body: CSV,
      });
    }
    if (url.includes('/api/audit/invocations')) {
      listUrls.push(url);
      return json([
        {
          id: 'log-1',
          createdAt: '2026-10-02T10:00:00.000Z',
          status: 'ERROR',
          durationMs: 42,
          mcpServerId: null,
          mcpServer: null,
          toolId: 't-1',
          tool: { name: 'search_customers', connector: { name: 'CRM', type: 'REST' } },
          input: { q: 'Müller' },
          output: null,
          error: 'boom',
          clientInfo: null,
        },
      ]);
    }
    return json({});
  });

  return { listUrls, exportUrls };
}

test.describe('Audit Log export', () => {
  test('an admin exports the filtered view as CSV with payloads', async ({ page }) => {
    const { listUrls, exportUrls } = await fakeSession(page);
    await page.goto('/logs');
    await expect(page.getByTitle('search_customers')).toBeVisible();

    await page.getByRole('button', { name: 'Errors', exact: true }).click();
    await page.getByLabel('From', { exact: true }).fill('2026-10-01');
    await page.getByLabel('To', { exact: true }).fill('2026-10-07');

    // The list follows the date range too; `to` is the midnight after the To day.
    await expect
      .poll(() => listUrls.at(-1) ?? '')
      .toContain('to=2026-10-07T22%3A00%3A00.000Z');
    const list = new URL(listUrls.at(-1)!);
    expect(list.searchParams.get('status')).toBe('ERROR');
    expect(list.searchParams.get('from')).toBe('2026-09-30T22:00:00.000Z');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Include input and output' }).click();
    // Toggling the option keeps the menu open.
    await expect(page.getByRole('menuitemcheckbox', { name: 'Include input and output' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download CSV' }).click();
    const download = await downloadPromise;

    expect(exportUrls).toHaveLength(1);
    const params = new URL(exportUrls[0]).searchParams;
    expect(params.get('format')).toBe('csv');
    expect(params.get('payloads')).toBe('true');
    expect(params.get('status')).toBe('ERROR');
    expect(params.get('from')).toBe('2026-09-30T22:00:00.000Z');
    expect(params.get('to')).toBe('2026-10-07T22:00:00.000Z');

    // Named after the local days, and saved byte for byte (BOM included).
    expect(download.suggestedFilename()).toBe('anythingmcp-audit-2026-10-01-2026-10-07.csv');
    const saved = await readFile((await download.path())!, 'utf8');
    expect(saved).toBe(CSV);

    // The stub's file was capped, so the page says how to get the rest.
    await expect(page.getByText('The export stopped at the row limit.')).toBeVisible();
  });

  test('a viewer reads the log without the Export menu', async ({ page }) => {
    await fakeSession(page, { role: 'VIEWER' });
    await page.goto('/logs');
    await expect(page.getByTitle('search_customers')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
  });

  test('on Cloud the admin sees what retention leaves to export', async ({ page }) => {
    await fakeSession(page, { deploymentMode: 'cloud' });
    await page.goto('/logs');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByRole('note', { name: /only what is still stored can be exported/ })).toBeVisible();
  });
});
