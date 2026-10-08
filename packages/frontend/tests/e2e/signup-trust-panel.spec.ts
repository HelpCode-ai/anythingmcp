import { expect, test, type Page } from '@playwright/test';

/**
 * The sign-up page's trust panel: live numbers when /api/public/stats answers,
 * badges only when it does not, and no Cloud-only claim on a self-hosted
 * instance. The backend is mocked.
 */

const info = (deploymentMode: 'cloud' | 'self-hosted') => ({
  deploymentMode,
  mcpAuthMode: 'oauth2',
  hasUsers: true,
  registrationEnabled: true,
  ssoProviders: [],
});

async function mock(page: Page, mode: 'cloud' | 'self-hosted', stats: unknown, status = 200) {
  await page.route(/\/(api|health)\//, (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/health/server-info') return route.fulfill({ json: info(mode) });
    if (p === '/api/public/stats') return route.fulfill({ status, json: stats });
    return route.fulfill({ json: {} });
  });
}

test('cloud sign-up shows the live numbers, rounded down', async ({ page }) => {
  await mock(page, 'cloud', {
    githubStars: 984,
    dockerPulls: 32_456,
    workspaces: 3_871,
    toolCalls30d: 654_321,
    updatedAt: '2026-10-07T10:00:00.000Z',
  });
  await page.goto('/login?mode=register');
  await expect(page.getByRole('heading', { name: 'Create your free account' })).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Why teams build on AnythingMCP' });
  await expect(panel.getByText('984')).toBeVisible();
  await expect(panel.getByText('32,000+')).toBeVisible();
  await expect(panel.getByText('650,000+')).toBeVisible();
  await expect(panel.getByText('3,800+')).toBeVisible();
  await expect(panel.getByText('Listed in the Claude Directory')).toBeVisible();
  await expect(panel.getByText('Your 7-day trial includes')).toBeVisible();
});

test('without numbers the tiles are hidden and the badges stay', async ({ page }) => {
  await mock(page, 'cloud', { message: 'down' }, 503);
  await page.goto('/login?mode=register');
  const panel = page.getByRole('complementary', { name: 'Why teams build on AnythingMCP' });
  await expect(panel.getByText('AES-256-GCM')).toBeVisible();
  await expect(page.getByTestId('trust-stats')).toHaveCount(0);
});

test('self-hosted sign-up makes no Cloud claims', async ({ page }) => {
  await mock(page, 'self-hosted', { githubStars: 984, dockerPulls: null, workspaces: 2, toolCalls30d: 10, updatedAt: null });
  await page.goto('/login?mode=register');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByText(/Frankfurt|7-day|DPA/)).toHaveCount(0);
  await expect(page.getByText('984 on GitHub · open source')).toBeVisible();
});

test('the Claude Directory badge is shown to Claude users and hidden for other AI clients', async ({ page }) => {
  await mock(page, 'cloud', { message: 'down' }, 503);
  const panel = page.getByRole('complementary', { name: 'Why teams build on AnythingMCP' });

  await page.goto('/login?mode=register&redirect=%2Fauth%2Flogin&client=claude');
  await expect(panel.getByText('Listed in the Claude Directory')).toBeVisible();

  for (const client of ['chatgpt', 'other']) {
    await page.goto(`/login?mode=register&redirect=%2Fauth%2Flogin&client=${client}`);
    await expect(panel.getByText('AES-256-GCM')).toBeVisible();
    await expect(panel.getByText('Listed in the Claude Directory')).toHaveCount(0);
  }
});
