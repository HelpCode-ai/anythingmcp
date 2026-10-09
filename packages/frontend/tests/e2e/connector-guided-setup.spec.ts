import { expect, test, type Page } from '@playwright/test';

/**
 * The guided connector setup replaces the store's install dialog: grouped
 * fields with where to find them, a check against the API before anything is
 * saved, "Save and sign in" for OAuth connectors, and a real result at the end.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const LEXWARE = {
  slug: 'lexware-office',
  name: 'Lexware Office',
  description: 'Invoices and vouchers',
  icon: 'lexware-office',
  instructions: '**Getting a token** in Einstellungen.',
  connector: { name: 'Lexware Office', type: 'REST', baseUrl: 'https://api.lexware.io/v1', authType: 'BEARER_TOKEN' },
  setupKind: 'credentials',
  envVars: [
    { name: 'LEXWARE_API_KEY', required: true, label: 'API key', kind: 'credential', secret: true, help: 'Einstellungen → Öffentliche API.' },
  ],
};

const ETSY = {
  slug: 'etsy',
  name: 'Etsy Open API v3',
  description: 'Your Etsy shop',
  icon: 'etsy',
  connector: { name: 'Etsy', type: 'REST', baseUrl: 'https://openapi.etsy.com/v3/application', authType: 'OAUTH2' },
  setupKind: 'oauth_browser',
  envVars: [
    { name: 'ETSY_CLIENT_ID', required: true, label: 'Keystring', kind: 'credential', secret: false },
    { name: 'ETSY_CLIENT_SECRET', required: true, label: 'Shared secret', kind: 'credential', secret: true, pattern: '^[a-z0-9]{8,32}$', patternMessage: 'Paste the Shared secret alone: lowercase letters and digits, without the Keystring and without a colon.' },
    { name: 'ETSY_REFRESH_TOKEN', required: false, label: 'Refresh token', kind: 'credential', secret: true, advanced: true },
  ],
};

interface Calls {
  verify: any[];
  imports: any[];
  envVars: any[];
  authorize: any[];
}

async function setup(
  page: Page,
  opts: { verify?: any; etsyVerify?: any; connector?: any; test?: any } = {},
): Promise<Calls> {
  const calls: Calls = { verify: [], imports: [], envVars: [], authorize: [] };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.endsWith('/api/adapters/lexware-office/verify')) {
      calls.verify.push(req.postDataJSON());
      return json(opts.verify ?? { ok: true, toolName: 'lexware_office_get_profile', durationMs: 120, sample: '{"companyName":"Acme GmbH"}' });
    }
    if (url.endsWith('/api/adapters/etsy/verify')) {
      calls.verify.push(req.postDataJSON());
      return json(opts.etsyVerify ?? { ok: null, skipped: 'authorization' });
    }
    if (url.includes('/api/adapters/lexware-office/import') || url.includes('/api/adapters/etsy/import')) {
      calls.imports.push(req.postDataJSON());
      return json({ message: 'ok', connectorId: 'c9', toolsCreated: 12, attachedToServer: { id: 's1', name: 'Default' } });
    }
    if (url.endsWith('/api/adapters/lexware-office')) return json(LEXWARE);
    if (url.endsWith('/api/adapters/etsy')) return json(ETSY);
    if (url.includes('/api/connectors/oauth/redirect-uri')) return json({ redirectUri: 'https://cloud.example.com/api/mcp-oauth/callback' });
    if (url.includes('/api/connectors/c9/oauth/authorize')) {
      calls.authorize.push(req.postDataJSON());
      return json({ authorizationUrl: 'https://www.etsy.com/oauth/connect?state=s1' });
    }
    if (url.includes('/api/connectors/c9/env-vars')) {
      calls.envVars.push(req.postDataJSON());
      return json({});
    }
    if (url.includes('/api/connectors/c9/test')) return json(opts.test ?? { ok: true, message: 'Connected' });
    if (url.includes('/api/connectors/c9')) return json(opts.connector ?? { id: 'c9', setupStatus: 'ready', envVars: {}, maskedEnvVars: [] });
    if (url.includes('/api/product-events')) return json({ ok: true });
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    return json({});
  });
  return calls;
}

test('checks the key before installing, and shows what the API answered', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/connectors/setup/lexware-office');
  await expect(page.getByRole('heading', { name: 'Set up Lexware Office' })).toBeVisible();
  await expect(page.getByText('Einstellungen → Öffentliche API.')).toBeVisible();

  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect(page.getByText('Required')).toBeVisible();
  expect(calls.verify).toHaveLength(0);

  await page.getByLabel('API key').fill(' key-123 ');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect(page.getByRole('heading', { name: 'Lexware Office is ready' })).toBeVisible();
  await expect(page.getByText('Acme GmbH')).toBeVisible();
  expect(calls.verify).toEqual([{ credentials: { LEXWARE_API_KEY: 'key-123' } }]);
  expect(calls.imports).toEqual([{ credentials: { LEXWARE_API_KEY: 'key-123' } }]);
});

test('does not install when the API refuses the key', async ({ page }) => {
  const calls = await setup(page, {
    verify: { ok: false, kind: 'auth_failed', status: 401, message: '401 Unauthorized: invalid token. Check the API key.' },
  });
  await page.goto('/connectors/setup/lexware-office');
  await page.getByLabel('API key').fill('wrong');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect(page.getByText('Lexware Office did not accept these credentials.')).toBeVisible();
  expect(calls.imports).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Save anyway' })).toBeVisible();
});

test('OAuth: saves the app keys and goes straight to the sign-in, with the way back', async ({ page }) => {
  const calls = await setup(page);
  await page.route('https://www.etsy.com/**', (route) => route.fulfill({ status: 200, body: 'Etsy consent page' }));
  await page.goto('/connectors/setup/etsy');
  await expect(page.getByText('https://cloud.example.com/api/mcp-oauth/callback')).toBeVisible();
  // The refresh token is folded away: the sign-in fills it in.
  await expect(page.getByLabel('Refresh token')).toBeHidden();
  // A text field then a password field reads as a login form: the browser
  // must not fill the user's own e-mail and password into the app's keys.
  await expect(page.getByLabel('Keystring')).toHaveAttribute('autocomplete', 'off');
  await expect(page.getByLabel('Shared secret')).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.getByLabel('Shared secret')).toHaveAttribute('data-1p-ignore', 'true');
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Save and sign in to Etsy' }).click();
  await page.waitForURL('https://www.etsy.com/oauth/connect?state=s1');
  // The app keys were checked before leaving for Etsy.
  expect(calls.verify[0].credentials).toMatchObject({ ETSY_CLIENT_ID: 'a1b2c3d4e5f6g7h8i9j0k1l2', ETSY_CLIENT_SECRET: 's3cr3t0abc' });
  expect(calls.imports[0].credentials).toMatchObject({ ETSY_CLIENT_ID: 'a1b2c3d4e5f6g7h8i9j0k1l2', ETSY_CLIENT_SECRET: 's3cr3t0abc' });
  expect(calls.authorize).toEqual([{ returnTo: '/connectors/setup/etsy?connector=c9&step=done' }]);
});

test('OAuth: app keys Etsy does not accept yet keep the user here, instead of an error page at Etsy', async ({ page }) => {
  // 7 Oct 2026: every Etsy user who left for the sign-in and never came back
  // had keys Etsy refused (an app still Pending, or the wrong shared secret).
  const calls = await setup(page, {
    etsyVerify: {
      ok: false,
      kind: 'auth_failed',
      status: 403,
      message: 'Etsy does not accept these app keys yet. A new Etsy app stays Pending until Etsy approves it.',
    },
  });
  await page.goto('/connectors/setup/etsy');
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Save and sign in to Etsy' }).click();
  await expect(page.getByText('Etsy Open API v3 did not accept these credentials.')).toBeVisible();
  await expect(page.getByText('stays Pending until Etsy approves it')).toBeVisible();
  expect(calls.imports).toHaveLength(0);
  expect(calls.authorize).toHaveLength(0);
  await expect(page).toHaveURL(/\/connectors\/setup\/etsy/);
});

test('OAuth: back from the provider, shows the connector ready', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/setup/etsy?connector=c9&step=done&from=claude');
  await expect(page.getByRole('heading', { name: 'Etsy Open API v3 is ready' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Claude' })).toBeVisible();
});

test('the way back names the assistant the setup came from, and only links where we chose', async ({ page }) => {
  await setup(page);
  const ready = page.getByRole('heading', { name: 'Etsy Open API v3 is ready' });
  const open = (from: string) => page.goto(`/connectors/setup/etsy?connector=c9&step=done&from=${encodeURIComponent(from)}`);
  const externalLinks = () =>
    page.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));

  await open('chatgpt');
  await expect(ready).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to ChatGPT' })).toHaveAttribute('href', 'https://chatgpt.com/');
  await expect(page.getByRole('link', { name: /Back to Claude/ })).toHaveCount(0);

  await open('claude');
  await expect(ready).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Claude' })).toHaveAttribute('href', 'https://claude.ai/new');

  // Muse runs in apps as well as on the web: named, not linked.
  await open('muse');
  await expect(ready).toBeVisible();
  await expect(page.getByText('You can close this tab and return to Meta Muse.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);

  // An assistant that is not known: neutral, no link.
  await open('assistant');
  await expect(ready).toBeVisible();
  await expect(page.getByText('You can close this tab and return to your AI assistant.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);

  // Whatever else the query says is ignored, a URL above all.
  for (const from of ['https://evil.example/phish', 'javascript:alert(1)', 'toString', 'Claude']) {
    await open(from);
    await expect(ready).toBeVisible();
    await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
    await expect(page.getByText(/return to/)).toHaveCount(0);
    expect((await externalLinks()).filter((h) => h.includes('evil') || h.startsWith('javascript'))).toEqual([]);
  }

  // A setup started in the dashboard has no way back to an assistant.
  await page.goto('/connectors/setup/etsy?connector=c9&step=done');
  await expect(ready).toBeVisible();
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});

test('OAuth: the sign-in keeps the assistant the setup came from', async ({ page }) => {
  const calls = await setup(page);
  await page.route('https://www.etsy.com/**', (route) => route.fulfill({ status: 200, body: 'Etsy consent page' }));
  await page.goto('/connectors/setup/etsy?connector=c9&from=chatgpt');
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Save and sign in to Etsy' }).click();
  await page.waitForURL('https://www.etsy.com/oauth/connect?state=s1');
  expect(calls.authorize).toEqual([{ returnTo: '/connectors/setup/etsy?connector=c9&step=done&from=chatgpt' }]);
});

test('OAuth: a sign-in that worked with wrong app keys goes back to the keys, not to "ready"', async ({ page }) => {
  // Etsy's token exchange does not check the shared secret; the first API
  // call does. Seen in production: users told "is ready", then every call 403.
  await setup(page, {
    test: { ok: false, kind: 'auth_failed', httpStatus: 403, message: 'Invalid API key: should be in the format keystring:shared_secret.' },
  });
  await page.goto('/connectors/setup/etsy?connector=c9&step=done&from=claude');
  await expect(page.getByText('Etsy Open API v3 did not accept these credentials.')).toBeVisible();
  await expect(page.getByText('should be in the format keystring:shared_secret')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Etsy Open API v3 is ready' })).toHaveCount(0);
  await expect(page.getByLabel('Shared secret')).toBeVisible();
});

test('a value that does not match the pattern says what to check', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/setup/etsy');
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('a1b2c3d4e5f6g7h8i9j0k1l2:abc');
  await page.getByRole('button', { name: 'Save and sign in to Etsy' }).click();
  await expect(page.getByText('Paste the Shared secret alone')).toBeVisible();
});

test('finishing an existing connector keeps a stored secret left empty', async ({ page }) => {
  const calls = await setup(page, {
    connector: { id: 'c9', setupStatus: 'needs_input', envVars: { LEXWARE_API_KEY: '' }, maskedEnvVars: ['LEXWARE_API_KEY'] },
  });
  await page.goto('/connectors/setup/lexware-office?connector=c9');
  await expect(page.getByRole('heading', { name: 'Finish setting up Lexware Office' })).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'Stored. Leave empty to keep it');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByRole('heading', { name: 'Lexware Office is ready' })).toBeVisible();
  expect(calls.verify).toEqual([{ credentials: { LEXWARE_API_KEY: '' }, connectorId: 'c9' }]);
  expect(calls.envVars).toEqual([{ envVars: { LEXWARE_API_KEY: '' } }]);
  expect(calls.imports).toHaveLength(0);
});
