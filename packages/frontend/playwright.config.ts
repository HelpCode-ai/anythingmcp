import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3100';
const reuseServer = process.env.PLAYWRIGHT_USE_RUNNING_SERVER === '1';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: reuseServer
    ? undefined
    : {
        // The frontend uses `output: 'standalone'`, which makes `next start`
        // refuse to run. The standalone build path embeds the absolute build
        // dir, which differs between local + CI. `next dev` boots the same
        // App Router and is good enough for these UI-only smoke checks.
        command: 'npx next dev --port 3100',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          NEXT_PUBLIC_API_URL:
            process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4100',
        },
      },
});
