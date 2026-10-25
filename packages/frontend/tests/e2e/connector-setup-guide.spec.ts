import { expect, test, type Page } from '@playwright/test';

/**
 * An adapter with a `setupGuide` is set up one step at a time: an intro,
 * the steps (what to open at the provider, what to type there, the fields),
 * then the success screen with the way into an AI client. The check, the
 * install and the sign-in are the guided setup's own (connector-guided-setup).
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };
const REDIRECT = 'https://cloud.example.com/api/mcp-oauth/callback';

const ETSY = {
  slug: 'etsy',
  name: 'Etsy',
  description: 'Your Etsy shop',
  icon: 'etsy',
  connector: { name: 'Etsy', type: 'REST', baseUrl: 'https://openapi.etsy.com/v3/application', authType: 'OAUTH2' },
  setupKind: 'oauth_browser',
  envVars: [
    { name: 'ETSY_CLIENT_ID', required: true, label: 'Keystring', kind: 'credential', secret: false },
    { name: 'ETSY_CLIENT_SECRET', required: true, label: 'Shared secret', kind: 'credential', secret: true },
    { name: 'ETSY_REFRESH_TOKEN', required: false, label: 'Refresh token', kind: 'credential', secret: true, advanced: true },
  ],
  setupGuide: {
    effort: 'own_app',
    minutes: 10,
    examples: ["Which orders haven't shipped yet?"],
    needs: ['Your Etsy seller account'],
    why: 'Etsy lets other tools reach a shop only through an app the owner registers.',
    steps: [
      {
        id: 'create-app',
        title: 'Create your Etsy app',
        body: 'Fill in the form as below.',
        action: { label: "Open Etsy's app form", url: 'https://www.etsy.com/developers/register' },
        values: [
          { label: 'Name', value: 'AnythingMCP' },
          { label: 'Application type', value: 'Seller Tools', pick: true },
        ],
        confirm: 'I created the app',
        problems: [{ q: 'Etsy shows a sign-in page', a: 'Sign in first.' }],
      },
      {
        id: 'callback',
        title: 'Add the callback URL',
        values: [{ label: 'Callback URL', value: '{{redirectUri}}' }],
        confirm: 'I added the callback URL and saved',
      },
      {
        id: 'keys',
        title: 'Copy your keys and sign in',
        fields: ['ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET'],
        problems: [{ q: 'My app says Pending', a: 'Etsy emails you when it is active.' }],
      },
    ],
  },
};

const WOO = {
  slug: 'woocommerce',
  name: 'WooCommerce',
  description: 'Your shop',
  icon: 'woocommerce',
  connector: { name: 'WooCommerce', type: 'REST', baseUrl: '{{WOOCOMMERCE_URL}}/wp-json/wc/v3', authType: 'QUERY_AUTH' },
  setupKind: 'credentials',
  envVars: [
    { name: 'WOOCOMMERCE_URL', required: true, label: 'Shop address', kind: 'address', secret: false, pattern: '^https://[^\\s?#]+[^/\\s?#]$', patternMessage: 'The https:// address of the site root.' },
    { name: 'WOOCOMMERCE_CONSUMER_KEY', required: true, label: 'Consumer key', kind: 'credential', secret: true },
    { name: 'WOOCOMMERCE_CONSUMER_SECRET', required: true, label: 'Consumer secret', kind: 'credential', secret: true },
  ],
  setupGuide: {
    effort: 'api_key',
    minutes: 4,
    examples: ['Which orders came in today?', 'Which products are out of stock?'],
    steps: [
      { id: 'shop', title: "Your shop's address", fields: ['WOOCOMMERCE_URL'] },
      {
        id: 'api-key',
        title: 'Create a REST API key',
        action: { label: 'Open the REST API keys', url: '{{WOOCOMMERCE_URL}}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&create-key=1' },
        fields: ['WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET'],
      },
    ],
  },
};

interface Calls {
  verify: any[];
  imports: any[];
  authorize: any[];
  events: any[];
}

async function setup(page: Page, opts: { verify?: any; calls30d?: number; authMode?: string } = {}): Promise<Calls> {
  const calls: Calls = { verify: [], imports: [], authorize: [], events: [] };
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/health\/server-info/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ mcpAuthMode: opts.authMode ?? 'oauth2', serverUrl: '', mcpEndpoint: '', deploymentMode: 'self-hosted' }),
    }),
  );
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (/\/api\/adapters\/(etsy|woocommerce)\/verify$/.test(url)) {
      calls.verify.push(req.postDataJSON());
      return json(opts.verify ?? { ok: true, toolName: 'probe', durationMs: 90, sample: '{"ok":true}' });
    }
    if (/\/api\/adapters\/(etsy|woocommerce)\/import$/.test(url)) {
      calls.imports.push(req.postDataJSON());
      return json({ message: 'ok', connectorId: 'c9', toolsCreated: 12, attachedToServer: { id: 's1', name: 'Default' } });
    }
    if (url.endsWith('/api/adapters/etsy')) return json(ETSY);
    if (url.endsWith('/api/adapters/woocommerce')) return json(WOO);
    if (url.includes('/api/connectors/oauth/redirect-uri')) return json({ redirectUri: REDIRECT });
    if (url.includes('/api/connectors/c9/oauth/authorize')) {
      calls.authorize.push(req.postDataJSON());
      return json({ authorizationUrl: 'https://www.etsy.com/oauth/connect?state=s1' });
    }
    if (url.includes('/api/connectors/c9/test')) return json({ ok: true, message: 'Connected' });
    if (url.includes('/api/connectors/c9')) {
      return json({ id: 'c9', setupStatus: 'ready', envVars: {}, maskedEnvVars: [], mcpServers: [{ mcpServerId: 's1' }] });
    }
    if (url.includes('/api/mcp-servers/s1/activity')) return json({ calls30d: opts.calls30d ?? 0, lastCallAt: null });
    if (url.includes('/api/mcp-servers/s1')) return json({ id: 's1', name: 'Default', slug: 'default' });
    if (url.includes('/api/product-events')) {
      calls.events.push(req.postDataJSON());
      return json({ ok: true });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    return json({});
  });
  return calls;
}

test('Etsy: intro, then one step at a time, then the sign-in', async ({ page }) => {
  const calls = await setup(page);
  await page.route('https://www.etsy.com/**', (route) => route.fulfill({ status: 200, body: 'Etsy consent page' }));
  await page.goto('/connectors/setup/etsy');

  // Intro: what it is for, what it takes, and why.
  await expect(page.getByRole('heading', { name: 'Connect Etsy to your AI' })).toBeVisible();
  await expect(page.getByText('Own app · 10 min')).toBeVisible();
  await expect(page.getByText("“Which orders haven't shipped yet?”")).toBeVisible();
  await page.getByText('Why do I need my own Etsy app?').click();
  await expect(page.getByText('only through an app the owner registers')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();

  // Step 1: the provider page opens in a new tab; what to type there.
  await expect(page.getByRole('heading', { name: 'Create your Etsy app' })).toBeVisible();
  const open = page.getByRole('link', { name: /Open Etsy's app form/ });
  await expect(open).toHaveAttribute('href', 'https://www.etsy.com/developers/register');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('code', { hasText: 'AnythingMCP' })).toBeVisible();
  await expect(page.getByText('Select Seller Tools')).toBeVisible();
  // Done at Etsy: confirmed before going on.
  const next = page.getByRole('button', { name: 'Continue' });
  await expect(next).toBeDisabled();
  await page.getByLabel('I created the app').check();
  await next.click();

  // Step 2: this instance's callback URL, to copy.
  await expect(page.getByRole('heading', { name: 'Add the callback URL' })).toBeVisible();
  await expect(page.getByText(REDIRECT)).toBeVisible();
  await page.getByLabel('I added the callback URL and saved').check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: the keys, checked, then off to Etsy.
  await expect(page.getByRole('heading', { name: 'Copy your keys and sign in' })).toBeVisible();
  await expect(page.getByLabel('Refresh token')).toBeHidden();
  await page.getByRole('button', { name: 'Check and sign in to Etsy' }).click();
  await expect(page.getByText('Required').first()).toBeVisible();
  expect(calls.verify).toHaveLength(0);
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Check and sign in to Etsy' }).click();
  await page.waitForURL('https://www.etsy.com/oauth/connect?state=s1');
  expect(calls.verify[0].credentials).toMatchObject({ ETSY_CLIENT_ID: 'a1b2c3d4e5f6g7h8i9j0k1l2', ETSY_CLIENT_SECRET: 's3cr3t0abc' });
  expect(calls.imports).toHaveLength(1);
  expect(calls.authorize).toEqual([{ returnTo: '/connectors/setup/etsy?connector=c9&step=done' }]);

  const viewed = calls.events.filter((e) => e.event === 'setup_step_viewed').map((e) => e.metadata.step);
  expect(viewed).toEqual(['create-app', 'callback', 'keys']);
});

test('Etsy: an app still Pending keeps the user on the keys step, and the page reopens there', async ({ page }) => {
  const calls = await setup(page, {
    verify: { ok: false, kind: 'auth_failed', status: 403, message: 'Etsy does not accept these app keys yet. A new Etsy app stays Pending until Etsy approves it.' },
  });
  await page.goto('/connectors/setup/etsy');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByLabel('I created the app').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('I added the callback URL and saved').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Check and sign in to Etsy' }).click();
  await expect(page.getByText('stays Pending until Etsy approves it')).toBeVisible();
  expect(calls.imports).toHaveLength(0);

  // Tomorrow, after Etsy's e-mail: straight back to the keys, boxes ticked,
  // and nothing typed was kept.
  await page.reload();
  await page.getByRole('button', { name: 'Continue at step 3: Copy your keys and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Copy your keys and sign in' })).toBeVisible();
  await expect(page.getByLabel('Shared secret')).toHaveValue('');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('I added the callback URL and saved')).toBeChecked();
});

test('the guide can be left for the one-page form, and back', async ({ page }) => {
  await setup(page);
  await page.goto('/connectors/setup/etsy');
  await page.getByRole('button', { name: 'Enter everything on one page' }).click();
  await expect(page.getByRole('heading', { name: 'Set up Etsy' })).toBeVisible();
  await expect(page.getByLabel('Keystring')).toBeVisible();
  await page.getByRole('button', { name: 'Prefer step by step? Use the guided setup' }).click();
  await expect(page.getByRole('heading', { name: 'Connect Etsy to your AI' })).toBeVisible();
});

test('WooCommerce: the link into the shop is built from the address of the step before', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/connectors/setup/woocommerce');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByLabel('Shop address').fill('https://shop.example.com/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('The https:// address of the site root.')).toBeVisible();
  await page.getByLabel('Shop address').fill('https://shop.example.com');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('link', { name: /Open the REST API keys/ })).toHaveAttribute(
    'href',
    'https://shop.example.com/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&create-key=1',
  );
  await page.getByLabel('Consumer key').fill('ck_' + 'a'.repeat(40));
  await page.getByLabel('Consumer secret').fill('cs_' + 'b'.repeat(40));
  await page.getByRole('button', { name: 'Check and connect' }).click();

  // Success: what to ask, and how to reach it from an AI client.
  await expect(page.getByRole('heading', { name: 'WooCommerce is connected' })).toBeVisible();
  await expect(page.getByText('“Which products are out of stock?”')).toBeVisible();
  await expect(page.getByText('http://localhost:4000/mcp/s1').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Add to Claude/ })).toHaveAttribute('href', /claude\.ai/);
  await page.getByRole('tab', { name: 'ChatGPT' }).click();
  await expect(page.getByRole('link', { name: /Open ChatGPT Plugins/ })).toHaveAttribute('href', 'https://chatgpt.com/plugins');
  expect(calls.imports[0].credentials).toMatchObject({ WOOCOMMERCE_URL: 'https://shop.example.com' });
});

test('success: a server an AI client already uses needs no new connection', async ({ page }) => {
  await setup(page, { calls30d: 12 });
  await page.goto('/connectors/setup/woocommerce?connector=c9&step=done');
  await expect(page.getByRole('heading', { name: 'WooCommerce is connected' })).toBeVisible();
  await expect(page.getByText('which your AI client already uses')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Claude' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect another AI client' }).click();
  await expect(page.getByRole('tab', { name: 'Claude' })).toBeVisible();
});

test('marketplace: each card says what the setup takes, and can be filtered by it', async ({ page }) => {
  await setup(page);
  const card = (slug: string, name: string, category: string, setupEffort: object) => ({
    slug, name, description: `${name} connector`, region: 'intl', category, icon: slug,
    docsUrl: 'https://example.test', requiredEnvVars: [], toolCount: 5, authType: 'API_KEY', setupEffort,
  });
  await page.route(/\/api\/adapters$/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        card('etsy', 'Etsy', 'e-commerce', { effort: 'own_app', minutes: 10 }),
        card('telegram-bot', 'Telegram Bot', 'messaging', { effort: 'api_key', minutes: 2 }),
        card('open-meteo', 'Open-Meteo', 'weather', { effort: 'none', minutes: 0 }),
      ]),
    }),
  );
  await page.route(/\/api\/adapters\/popular-connectors$/, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ slug: 'telegram-bot' }] }) }),
  );
  await page.goto('/connectors/store');
  await expect(page.getByText('Own app · 10 min')).toBeVisible();
  await expect(page.getByText('API key · 2 min')).toBeVisible();
  await expect(page.getByText('No setup', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Popular', { exact: true })).toHaveCount(1);

  await page.getByRole('group', { name: 'Setup' }).getByRole('button', { name: /Own app/ }).click();
  await expect(page.getByText('1 of 3 adapters')).toBeVisible();
  await expect(page.getByText('Telegram Bot', { exact: true })).toHaveCount(0);
});

test('finishing an existing connector can skip to the keys, and a refusal does not follow you back', async ({ page }) => {
  await setup(page, { verify: { ok: false, kind: 'auth_failed', status: 403, message: 'Etsy does not accept these app keys yet.' } });
  await page.goto('/connectors/setup/etsy?connector=c9');
  await page.getByRole('button', { name: 'Done the rest already? Go to step 3: Copy your keys and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Copy your keys and sign in' })).toBeVisible();
  await page.getByLabel('Keystring').fill('a1b2c3d4e5f6g7h8i9j0k1l2');
  await page.getByLabel('Shared secret').fill('s3cr3t0abc');
  await page.getByRole('button', { name: 'Check and sign in to Etsy' }).click();
  await expect(page.getByText('Etsy does not accept these app keys yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Add the callback URL' })).toBeVisible();
  await expect(page.getByText('Etsy does not accept these app keys yet.')).toHaveCount(0);
});

test('success: an instance on API keys does not send people to add the URL in Claude', async ({ page }) => {
  await setup(page, { authMode: 'legacy' });
  await page.goto('/connectors/setup/woocommerce?connector=c9&step=done');
  await expect(page.getByRole('heading', { name: 'WooCommerce is connected' })).toBeVisible();
  await expect(page.getByTestId('setup-no-oauth')).toBeVisible();
  await expect(page.getByRole('link', { name: /Add to Claude/ })).toHaveCount(0);
});
