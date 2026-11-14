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

test('cloud sign-up shows the numbers, never below their floors', async ({ page }) => {
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
  await expect(panel.getByText('200,000+')).toBeVisible();
  await expect(panel.getByText('2M+')).toBeVisible();
  await expect(panel.getByText('3,800+')).toBeVisible();
  await expect(panel.getByText(/stars on GitHub/)).toHaveCount(0);
  await expect(panel.getByText('Listed in the Claude Directory')).toBeVisible();
  await expect(panel.getByText('Listed in the ChatGPT Plugin Directory')).toBeVisible();
  await expect(panel.getByText('Your 7-day trial includes')).toBeVisible();
});

test('without live numbers the floors are shown and workspaces left out', async ({ page }) => {
  await mock(page, 'cloud', { message: 'down' }, 503);
  await page.goto('/login?mode=register');
  const panel = page.getByRole('complementary', { name: 'Why teams build on AnythingMCP' });
  await expect(panel.getByText('AES-256-GCM')).toBeVisible();
  await expect(panel.getByText('200,000+')).toBeVisible();
  await expect(panel.getByText(/workspaces on/)).toHaveCount(0);
});

test('self-hosted sign-up makes no Cloud claims', async ({ page }) => {
  await mock(page, 'self-hosted', { githubStars: 984, dockerPulls: null, workspaces: 2, toolCalls30d: 10, updatedAt: null });
  await page.goto('/login?mode=register');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByText(/Frankfurt|7-day|DPA/)).toHaveCount(0);
  await expect(page.getByText('Open source on GitHub')).toBeVisible();
});

test('each assistant sees only its own directory badge, Muse neither, anyone else both', async ({ page }) => {
  await mock(page, 'cloud', { message: 'down' }, 503);
  const panel = page.getByRole('complementary', { name: 'Why teams build on AnythingMCP' });
  const claude = panel.getByRole('link', { name: 'Listed in the Claude Directory' });
  const chatgpt = panel.getByRole('link', { name: 'Listed in the ChatGPT Plugin Directory' });
  const expected: Record<string, [boolean, boolean]> = {
    claude: [true, false],
    chatgpt: [false, true],
    muse: [false, false],
    other: [true, true],
  };

  for (const [client, [showsClaude, showsChatgpt]] of Object.entries(expected)) {
    await page.goto(`/login?mode=register&redirect=%2Fauth%2Flogin&client=${client}`);
    await expect(panel.getByText('AES-256-GCM')).toBeVisible();
    await expect(claude).toHaveCount(showsClaude ? 1 : 0);
    await expect(chatgpt).toHaveCount(showsChatgpt ? 1 : 0);
  }
  await expect(chatgpt).toHaveAttribute(
    'href',
    'https://chatgpt.com/plugins/plugin_asdk_app_6ade03541ce08191b35bbad1dc5b4121',
  );
});
