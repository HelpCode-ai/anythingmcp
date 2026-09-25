import { devices, expect, test, type Page } from '@playwright/test';

/**
 * The starter pack on /welcome: keyless connectors, ticked by default, added
 * in one click. Covers the choice, the request it sends, the outcome with its
 * "Try it" links and the path to connecting a client, partial failures, and
 * a phone-width layout with no horizontal scrolling in either state.
 *
 * Same fake session as the other specs: seed the cookie and localStorage and
 * stub /api/*. The onboarding state is "not completed" with no connectors,
 * which is exactly who lands on /welcome.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const PACK = [
  { slug: 'agent-skills', name: 'Agent Skills Finder', pitch: 'Find a ready-made skill for a task, like a README or release notes, and have your AI follow it.', icon: 'agent-skills', category: 'knowledge', toolCount: 7, preselected: true, installed: false },
  { slug: 'hackernews', name: 'Hacker News', pitch: 'Top, new and Ask HN stories with their comments, for tech news and research.', icon: 'hackernews', category: 'data', toolCount: 8, preselected: true, installed: false },
  { slug: 'nominatim', name: 'Nominatim (OpenStreetMap)', pitch: 'Turn addresses into coordinates and back, worldwide, with OpenStreetMap.', icon: 'openstreetmap', category: 'maps', toolCount: 4, preselected: true, installed: false },
  { slug: 'vies-vat', name: 'VIES VAT Validation', pitch: 'Check that an EU VAT number is valid and see the company it belongs to.', icon: 'vies', category: 'government', toolCount: 1, preselected: false, installed: false },
  { slug: 'openplz', name: 'OpenPLZ Germany', pitch: 'German postal codes, towns and streets, for checking addresses.', icon: 'openplz', category: 'government', toolCount: 5, preselected: false, installed: false },
];

type InstallReply = { status: number; body: unknown };

async function openWelcome(
  page: Page,
  opts: { pack?: unknown; install?: (slugs: string[]) => InstallReply } = {},
) {
  const posted: string[][] = [];
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p.endsWith('/adapters/starter-pack/install') && req.method() === 'POST') {
      const slugs = (req.postDataJSON() as { slugs: string[] }).slugs;
      posted.push(slugs);
      const reply = opts.install
        ? opts.install(slugs)
        : {
            status: 201,
            body: {
              results: slugs.map((s) => ({ slug: s, status: 'installed', connectorId: `c-${s}`, toolsCreated: 4, probeOk: true })),
              server: { id: 's1', name: 'Default (Test)' },
            },
          };
      return json(reply.body, reply.status);
    }
    if (p.endsWith('/adapters/starter-pack')) return json(opts.pack ?? PACK);
    if (p.endsWith('/adapters')) return json([]);
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: null });
    if (p.endsWith('/users/me')) return json(USER);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (p.endsWith('/license/status')) return json({ plan: 'community', status: 'active' });
    if (p.endsWith('/connectors')) return json([]);
    return json({});
  });

  await page.goto('/welcome');
  return posted;
}

async function shot(page: Page, name: string) {
  if (!process.env.STARTER_SHOTS) return;
  await page.screenshot({ path: `${process.env.STARTER_SHOTS}/${name}.png`, fullPage: true });
}

test.describe('starter pack on /welcome', () => {
  test('ticks the preselected connectors and adds exactly the ones left ticked', async ({ page }) => {
    const posted = await openWelcome(page);

    const pack = page.getByRole('region', { name: 'Start with connectors that need no keys' });
    await expect(pack).toBeVisible();
    await expect(pack.getByRole('checkbox')).toHaveCount(5);
    await expect(pack.getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(pack.getByRole('button', { name: 'Add 3 connectors' })).toBeEnabled();
    await shot(page, 'desktop-choose');

    // Untick one, tick an optional one: the count and the request follow.
    await pack.getByText('Hacker News', { exact: true }).click();
    await pack.getByText('VIES VAT Validation', { exact: true }).click();
    await expect(pack.getByText('3 of 5 selected.')).toBeVisible();
    await pack.getByRole('button', { name: 'Add 3 connectors' }).click();

    await expect(pack.getByRole('status')).toHaveText('Added 3 connectors to Default (Test).');
    expect(posted).toEqual([['agent-skills', 'nominatim', 'vies-vat']]);

    // Each added connector with a demo gets a live "Try it" call.
    const tryIt = pack.getByRole('link', { name: 'Try it →' });
    await expect(tryIt).toHaveCount(3);
    await expect(tryIt.first()).toHaveAttribute(
      'href',
      '/connectors/c-agent-skills?demoTool=skills_search&autorun=1&from=welcome',
    );
    await expect(pack.getByRole('link', { name: 'Connect your AI client →' })).toHaveAttribute(
      'href',
      '/mcp-server/s1',
    );
    await shot(page, 'desktop-done');
  });

  test('cannot submit an empty selection', async ({ page }) => {
    const posted = await openWelcome(page);
    const pack = page.getByRole('region', { name: 'Start with connectors that need no keys' });
    for (const name of ['Agent Skills Finder', 'Hacker News', 'Nominatim (OpenStreetMap)']) {
      await pack.getByText(name, { exact: true }).click();
    }
    await expect(pack.getByRole('button', { name: 'Select a connector' })).toBeDisabled();
    expect(posted).toEqual([]);
  });

  test('shows what the workspace already has as done, and does not resend it', async ({ page }) => {
    const pack = PACK.map((i) => (i.slug === 'hackernews' ? { ...i, installed: true } : i));
    const posted = await openWelcome(page, { pack });
    const region = page.getByRole('region', { name: 'Start with connectors that need no keys' });

    await expect(region.getByText('Already added')).toBeVisible();
    await expect(region.getByRole('checkbox', { name: /Hacker News/ })).toBeDisabled();
    await region.getByRole('button', { name: 'Add 2 connectors' }).click();
    await expect(region.getByRole('status')).toContainText('Added 2 connectors');
    expect(posted).toEqual([['agent-skills', 'nominatim']]);
  });

  test('reports a connector that could not be added and keeps the others', async ({ page }) => {
    await openWelcome(page, {
      install: (slugs) => ({
        status: 201,
        body: {
          results: slugs.map((s, i) =>
            i === 1
              ? { slug: s, status: 'failed', error: 'Trial limit reached (2 connectors).' }
              : { slug: s, status: 'installed', connectorId: `c-${s}`, toolsCreated: 4, probeOk: true },
          ),
          server: { id: 's1', name: 'Default (Test)' },
        },
      }),
    });
    const region = page.getByRole('region', { name: 'Start with connectors that need no keys' });
    await region.getByRole('button', { name: 'Add 3 connectors' }).click();

    await expect(region.getByRole('status')).toHaveText('Added 2 connectors to Default (Test).');
    await expect(region.getByText('Not added: Trial limit reached (2 connectors).')).toBeVisible();
    await expect(region.getByRole('link', { name: 'Try it →' })).toHaveCount(2);
  });

  test('keeps the selection and says so when the request itself fails', async ({ page }) => {
    await openWelcome(page, {
      install: () => ({ status: 500, body: { message: 'Server unavailable' } }),
    });
    const region = page.getByRole('region', { name: 'Start with connectors that need no keys' });
    await region.getByRole('button', { name: 'Add 3 connectors' }).click();

    await expect(region.getByRole('alert')).toBeVisible();
    await expect(region.getByRole('checkbox', { checked: true })).toHaveCount(3);
    await expect(region.getByRole('button', { name: 'Add 3 connectors' })).toBeEnabled();
  });

  test('stays out of the way when there is nothing to offer', async ({ page }) => {
    await openWelcome(page, { pack: [] });
    await expect(page.getByText('Browse the marketplace')).toBeVisible();
    await expect(page.getByText('Starter pack')).toHaveCount(0);
  });
});

test.describe('starter pack at phone width', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13'];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  async function overflow(page: Page) {
    return page.evaluate(() => ({
      vw: document.documentElement.clientWidth,
      doc: document.documentElement.scrollWidth,
      main: document.querySelector('main')?.scrollWidth ?? 0,
    }));
  }

  test('fits the screen before and after adding, with a full-width button', async ({ page }) => {
    await openWelcome(page);
    const region = page.getByRole('region', { name: 'Start with connectors that need no keys' });
    await expect(region.getByRole('checkbox')).toHaveCount(5);
    await page.waitForTimeout(300);

    let o = await overflow(page);
    expect(o.doc).toBeLessThanOrEqual(o.vw);
    expect(o.main).toBeLessThanOrEqual(o.vw);

    const button = region.getByRole('button', { name: 'Add 3 connectors' });
    const box = await button.boundingBox();
    const regionBox = await region.boundingBox();
    expect(box!.width).toBeGreaterThan(regionBox!.width - 2);
    // A comfortable tap target.
    expect(box!.height).toBeGreaterThanOrEqual(40);
    await shot(page, 'mobile-choose');

    await button.click();
    await expect(region.getByRole('status')).toContainText('Added 3 connectors');
    o = await overflow(page);
    expect(o.doc).toBeLessThanOrEqual(o.vw);
    expect(o.main).toBeLessThanOrEqual(o.vw);
    await shot(page, 'mobile-done');
  });
});
