import { expect, test, type Page, type Route } from '@playwright/test';
import type { ToolPerformance } from '../../src/lib/api';

const USER = {
  id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN',
  organizationId: 'o1', emailVerified: true,
};

const ITEM: ToolPerformance = {
  toolId: 't1', toolName: 'fetch_orders', connectorId: 'c1', connectorName: 'Orders API',
  mcpServerId: 's1', mcpServerName: 'Production', calls: 12, errors: 4, errorRate: 33.33,
  latencySampleCount: 8, p50Ms: 0, p95Ms: 8.5, p99Ms: 13.5,
  lastError: 'Upstream rate limited\nTry again later', lastErrorAt: '2026-11-01T12:30:00.000Z',
};

async function fakeSession(page: Page, performance: (route: Route) => Promise<void>) {
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/(api|health)\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = async (body: unknown) => { await route.fulfill({ json: body }); };
    if (path === '/api/audit/tool-performance') return performance(route);
    if (path === '/health/server-info') return json({ deploymentMode: 'self-hosted', hasUsers: true, ssoProviders: [] });
    if (path === '/api/users/me/onboarding-state') return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (path === '/api/users/me') return json(USER);
    if (path === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (path === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: 'ADMIN' }]);
    if (path === '/api/license/status') return json({ plan: 'community', status: 'active' });
    if (path === '/api/connectors') return json([{ id: 'c1', name: 'Orders API' }, { id: 'c2', name: 'Search API' }]);
    if (path === '/api/mcp-servers') return json([{ id: 's1', name: 'Production' }]);
    if (path === '/api/audit/analytics') {
      const days = Number(new URL(route.request().url()).searchParams.get('days'));
      return json({
        daily: [], topTools: [{ name: `top_tool_${days}d`, count: days, errors: 0 }],
        totalInvocations: days, successRate: 100, avgDuration: 20,
      });
    }
    if (path === '/api/audit/breakdowns') return json({
      days: Number(new URL(route.request().url()).searchParams.get('days')), total: 0, errors: 0, proxyCalls: 0, estCostMicros: 0,
      rates: { callMicros: 0, proxyCallMicros: 0 }, byConnector: [], byServer: [], byUser: [],
    });
    return json({});
  });
}

const card = (page: Page) => page.locator('[aria-labelledby="tool-performance-title"]');

async function selectFilter(page: Page, name: string, option: string) {
  await card(page).getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('defaults to 24 hours and shows stored-sample latency, zeroes and the last error', async ({ page }, testInfo) => {
  const requests: URL[] = [];
  const overviewRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/audit/analytics') overviewRequests.push(url);
  });
  await fakeSession(page, async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ json: { items: [ITEM, {
      ...ITEM, toolId: 't2', toolName: 'ping', mcpServerId: null, mcpServerName: null,
      calls: 1, errors: 0, errorRate: 0, latencySampleCount: 0,
      p50Ms: null, p95Ms: null, p99Ms: null, lastError: null, lastErrorAt: null,
    }], hasMore: false } });
  });
  await page.goto('/analytics');
  const table = card(page).getByRole('table', { name: 'Tool performance' });
  await expect(table).toBeVisible();
  expect(requests[0].searchParams.get('hours')).toBe('24');
  expect(requests[0].searchParams.get('limit')).toBe('25');
  expect(requests[0].searchParams.get('offset')).toBe('0');
  expect(overviewRequests[0].searchParams.get('days')).toBe('30');
  await expect(page.getByText('Top tools', { exact: true })).toBeVisible();
  await expect(page.getByText('top_tool_30d', { exact: true })).toBeVisible();
  await expect(card(page)).toContainText('This table has its own time range.');
  await expect(card(page).getByRole('combobox', { name: 'Tool performance time range' })).toHaveText('Last 24 hours');
  const performanceRequestCount = requests.length;
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await expect.poll(() => overviewRequests.at(-1)?.searchParams.get('days')).toBe('7');
  await expect(page.getByText('top_tool_7d', { exact: true })).toBeVisible();
  await expect(page.getByText('top_tool_30d', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '90d', exact: true }).click();
  await expect(page.getByText('top_tool_90d', { exact: true })).toBeVisible();
  await expect(card(page).getByRole('combobox', { name: 'Tool performance time range' })).toHaveText('Last 24 hours');
  expect(requests).toHaveLength(performanceRequestCount);

  const row = table.getByRole('row').filter({ hasText: 'fetch_orders' });
  await expect(row.getByRole('cell').nth(2)).toHaveText('12');
  await expect(row.getByRole('cell').nth(3)).toContainText('33.33%');
  await expect(row.getByRole('cell').nth(4)).toContainText('0 ms');
  await expect(row.getByRole('cell').nth(4)).toContainText('8 stored samples');
  await expect(row.getByRole('cell').nth(5)).toHaveText('8.5 ms');
  await expect(row.getByRole('cell').nth(6)).toHaveText('13.5 ms');
  await row.locator('summary').click();
  await expect(row.locator('details p')).toHaveText(ITEM.lastError!);
  await expect(row.locator('time')).toHaveAttribute('datetime', ITEM.lastErrorAt!);

  const missing = table.getByRole('row').filter({ hasText: 'ping' });
  await expect(missing.getByRole('cell').nth(1)).toHaveText('Direct / no server');
  await expect(missing.getByRole('cell').nth(4)).toContainText('—');
  await expect(missing.getByRole('cell').nth(5)).toHaveText('—');
  await expect(card(page).getByText('Latency uses stored samples. Repeated failures are counted on their first recorded server.')).toBeVisible();
  await card(page).screenshot({ path: testInfo.outputPath('tool-performance-desktop.png') });
});

test('paginates and sends both filters and the selected period, resetting the page', async ({ page }) => {
  const requests: URL[] = [];
  await fakeSession(page, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const name = url.searchParams.get('offset') === '25' ? 'page_two' : 'fetch_orders';
    await route.fulfill({ json: { items: [{ ...ITEM, toolName: name }], hasMore: url.searchParams.get('offset') === '0' } });
  });
  await page.goto('/analytics');
  await expect(card(page).getByRole('table')).toBeVisible();
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card(page).getByText('page_two', { exact: true })).toBeVisible();
  await expect(card(page).getByText('Page 2', { exact: true })).toBeVisible();
  await card(page).getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(card(page).getByText('Page 1', { exact: true })).toBeVisible();
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card(page).getByText('page_two', { exact: true })).toBeVisible();
  await selectFilter(page, 'Filter tool performance by connector', 'Orders API');
  await expect(card(page).getByText('Page 1', { exact: true })).toBeVisible();
  await expect.poll(() => requests.at(-1)?.searchParams.get('connectorId')).toBe('c1');
  expect(requests.at(-1)?.searchParams.get('offset')).toBe('0');
  await selectFilter(page, 'Filter tool performance by MCP server', 'Production');
  await expect.poll(() => requests.at(-1)?.searchParams.get('mcpServerId')).toBe('s1');
  await selectFilter(page, 'Tool performance time range', 'Last 7 days');
  await expect.poll(() => requests.at(-1)?.searchParams.get('hours')).toBe('168');
  expect(requests.at(-1)?.searchParams.get('connectorId')).toBe('c1');
  expect(requests.at(-1)?.searchParams.get('mcpServerId')).toBe('s1');
});

test('shows an empty result without enabling the next page', async ({ page }) => {
  await fakeSession(page, async (route) => {
    await route.fulfill({ json: { items: [], hasMore: false } });
  });
  await page.goto('/analytics');
  await expect(card(page).getByText('No tool calls in this period match these filters.')).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('a populated performance table stays within the mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeSession(page, async (route) => {
    await route.fulfill({ json: { items: [ITEM], hasMore: false } });
  });
  await page.goto('/analytics');
  await expect(card(page).getByRole('table')).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  await card(page).screenshot({ path: testInfo.outputPath('tool-performance-mobile.png') });
});

test('reports a request failure and retries without keeping the old error', async ({ page }) => {
  let attempts = 0;
  let unavailable = true;
  await fakeSession(page, async (route) => {
    attempts += 1;
    if (unavailable) {
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    } else {
      await route.fulfill({ json: { items: [ITEM], hasMore: false } });
    }
  });
  await page.goto('/analytics');
  await expect(card(page).getByRole('alert')).toContainText('Could not load tool performance.');
  const attemptsBeforeRetry = attempts;
  unavailable = false;
  await card(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(card(page).getByRole('table')).toBeVisible();
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  expect(attempts).toBeGreaterThan(attemptsBeforeRetry);
});

test('an older filter response cannot replace the latest selection', async ({ page }) => {
  let releaseSlow: (() => void) | undefined;
  await fakeSession(page, async (route) => {
    const connector = new URL(route.request().url()).searchParams.get('connectorId');
    if (connector === 'c1') await new Promise<void>((resolve) => { releaseSlow = resolve; });
    await route.fulfill({ json: {
      items: [{ ...ITEM, toolName: connector === 'c1' ? 'stale_tool' : connector === 'c2' ? 'latest_tool' : 'initial_tool' }],
      hasMore: false,
    } });
  });
  await page.goto('/analytics');
  await expect(card(page).getByText('initial_tool', { exact: true })).toBeVisible();
  await selectFilter(page, 'Filter tool performance by connector', 'Orders API');
  await expect.poll(() => Boolean(releaseSlow)).toBe(true);
  await selectFilter(page, 'Filter tool performance by connector', 'Search API');
  await expect(card(page).getByText('latest_tool', { exact: true })).toBeVisible();

  const slowResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('connectorId') === 'c1');
  releaseSlow!();
  await (await slowResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card(page).getByText('latest_tool', { exact: true })).toBeVisible();
  await expect(card(page).getByText('stale_tool', { exact: true })).toHaveCount(0);
});
