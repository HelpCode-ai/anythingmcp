import { expect, test, type Page } from '@playwright/test';

/**
 * File Search wizard on Cloud, for a NAS inside the user's network:
 *  - a private address (192.168.x.x, nas.local) or a QuickConnect link shows
 *    how to make the NAS reachable before the test runs;
 *  - a test that could not reach the server shows the same help, with the
 *    Cloud's outbound address for the NAS firewall;
 *  - "Switch to WebDAV" goes back to the form on WebDAV;
 *  - a self-hosted instance shows none of it.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const QUOTA = {
  plan: 'team',
  maxConnectors: 3,
  maxFiles: 10000,
  maxSourceBytes: null,
  maxTextChars: null,
  maxFileBytes: 52428800,
  minIntervalMinutes: 60,
  manualSyncsPerDay: null,
  share: null,
  ocr: false,
  folderRules: true,
  policy: true,
};

function capabilities(cloud: boolean) {
  return {
    cloud,
    worker: { ok: true, extractor: true, ocr: false },
    access: { allowed: true, plan: 'team', quota: QUOTA, next: null },
    protocols: cloud ? ['sftp', 'ftps', 'webdav', 's3'] : ['sftp', 'ftps', 'webdav', 'local', 's3'],
    localRoots: [],
    ai: { available: false, allowedByPolicy: false, provider: null, model: null },
    policy: { publicLinks: true, maxTtlHours: null, aiDrafting: true, allowPlainFtp: false },
    intervals: [60, 1440],
    usage: { connectors: 0, files: 0, bytes: 0, textChars: 0 },
  };
}

async function setup(page: Page, opts: { cloud?: boolean; test?: unknown } = {}) {
  const cloud = opts.cloud ?? true;
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/api/file-search/capabilities')) return json(capabilities(cloud));
    if (url.includes('/api/file-search/test')) {
      return json(
        opts.test ?? {
          ok: false,
          steps: [{ key: 'resolve', ok: true }, { key: 'connect', ok: false, detail: 'The server is not reachable from here.' }],
          errorKind: 'unreachable',
          message: 'The server is not reachable from here.',
        },
      );
    }
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: true, egressIps: cloud ? ['104.248.242.235'] : [] });
    if (url.includes('/api/mcp-servers')) return json([]);
    if (url.includes('/api/product-events')) return json({ ok: true });
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'team', status: 'active' });
    return json({});
  });
}

const help = (page: Page) => page.getByTestId('nas-reachability-help');

async function fillLogin(page: Page) {
  await page.getByLabel('User name').fill('admin');
  await page.getByRole('textbox', { name: 'Password' }).fill('secret');
}

test('a private NAS address shows how to make it reachable, and Switch to WebDAV changes the form', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/new/file-search?preset=synology');
  await page.getByLabel('Server').fill('192.168.1.20');
  await expect(help(page)).toContainText('This address only works inside your network');
  await expect(help(page)).toContainText('yourname.synology.me:5006');
  await expect(help(page)).toContainText('104.248.242.235');

  await help(page).getByRole('button', { name: 'Switch to WebDAV' }).click();
  await expect(page.getByLabel('WebDAV address')).toBeVisible();
  await expect(help(page)).toHaveCount(0);
});

test('a QuickConnect link is called out', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/new/file-search?protocol=webdav');
  await page.getByLabel('WebDAV address').fill('https://quickconnect.to/mynas');
  await expect(help(page)).toContainText('QuickConnect links do not work here');
  await expect(help(page).getByRole('button', { name: 'Switch to WebDAV' })).toHaveCount(0);
});

test('a public address shows no help until the test cannot reach it', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/new/file-search?preset=synology');
  await page.getByLabel('Server').fill('files.example.com');
  await fillLogin(page);
  await expect(help(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(help(page)).toContainText('AnythingMCP Cloud could not reach the server');
});

test('a self-hosted instance shows none of it', async ({ page }) => {
  await setup(page, { cloud: false });
  await page.goto('/connectors/new/file-search?preset=synology');
  await page.getByLabel('Server').fill('192.168.1.20');
  await fillLogin(page);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('The server is not reachable from here.')).toBeVisible();
  await expect(help(page)).toHaveCount(0);
});
