import { expect, test, type Page } from '@playwright/test';

/**
 * The guided setup on an Odoo address:
 *  - typed without https:// (as the address bar shows it), it gets https://
 *    instead of being refused with a message that never named the fix;
 *  - a value still wrong says what to change;
 *  - an Odoo below 19 offers the switch to the JSON-RPC connector, started
 *    with the address and database (never the key), and the draft left
 *    behind is deleted once the new connector is saved.
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const URL_PATTERN = '^https?://(?!www\\.[^/]+\\.odoo\\.com)[^\\s/?#]+/?$';
const URL_MESSAGE = 'Only the address up to the host, e.g. https://mycompany.odoo.com (no www. on odoo.com, nothing after the host).';

const ODOO = {
  slug: 'odoo',
  name: 'Odoo',
  description: 'Odoo ERP 19 and newer',
  icon: 'odoo',
  connector: { name: 'Odoo', type: 'REST', baseUrl: '{{ODOO_URL}}/json/2', authType: 'BEARER_TOKEN' },
  setupKind: 'credentials',
  envVars: [
    { name: 'ODOO_URL', required: true, label: 'Odoo address', kind: 'address', secret: false, pattern: URL_PATTERN, patternMessage: URL_MESSAGE },
    { name: 'ODOO_DB', required: true, label: 'Database name', kind: 'setting', secret: false },
    { name: 'ODOO_API_KEY', required: true, label: 'API key', kind: 'credential', secret: true },
  ],
};

const ODOO_JSONRPC = {
  ...ODOO,
  slug: 'odoo-jsonrpc',
  name: 'Odoo 14-18 (JSON-RPC)',
  description: 'Odoo ERP 14 to 18',
  connector: { name: 'Odoo 14-18 (JSON-RPC)', type: 'REST', baseUrl: '{{ODOO_URL}}', authType: 'NONE' },
  envVars: [
    ODOO.envVars[0],
    ODOO.envVars[1],
    { name: 'ODOO_UID', required: true, label: 'User ID', kind: 'setting', secret: false, pattern: '^[0-9]+$' },
    ODOO.envVars[2],
  ],
};

interface Calls {
  verify: any[];
  imports: any[];
  deleted: string[];
}

async function setup(page: Page, opts: { verify?: unknown; draft?: Record<string, unknown> } = {}): Promise<Calls> {
  const calls: Calls = { verify: [], imports: [], deleted: [] };
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
    if (/\/api\/adapters\/[a-z-]+\/verify$/.test(url)) {
      calls.verify.push({ url, body: req.postDataJSON() });
      return json(url.includes('odoo-jsonrpc') ? { ok: true, toolName: 'x', durationMs: 5, sample: 'ok' } : (opts.verify ?? { ok: false, kind: 'auth_failed', status: 401, message: 'Invalid API key' }));
    }
    if (/\/api\/adapters\/[a-z-]+\/import$/.test(url)) {
      calls.imports.push({ url, body: req.postDataJSON() });
      return json({ connectorId: 'c-new', toolsCreated: 3, probe: null });
    }
    if (url.endsWith('/api/adapters/odoo-jsonrpc')) return json(ODOO_JSONRPC);
    if (url.endsWith('/api/adapters/odoo')) return json(ODOO);
    if (url.endsWith('/api/connectors/c-draft')) {
      if (req.method() === 'DELETE') {
        calls.deleted.push('c-draft');
        return json({ message: 'Connector deleted' });
      }
      return json(opts.draft ?? {});
    }
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

test('an address typed without https:// gets it, and is sent with it', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/connectors/setup/odoo');
  await page.getByLabel('Odoo address').fill('amcp-e2e-test.odoo.com');
  await page.getByLabel('Database name').fill('amcp-e2e-test');
  await expect(page.getByLabel('Odoo address')).toHaveValue('https://amcp-e2e-test.odoo.com');
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect.poll(() => calls.verify.length).toBe(1);
  expect(calls.verify[0].body.credentials.ODOO_URL).toBe('https://amcp-e2e-test.odoo.com');
  await expect(page.getByText(URL_MESSAGE)).toHaveCount(0);
});

test('an address still wrong says what to change', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/connectors/setup/odoo');
  await page.getByLabel('Odoo address').fill('acme.odoo.com/odoo/discuss');
  await page.getByLabel('Database name').fill('acme');
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect(page.getByText('Add https:// in front and remove /odoo/discuss after the host: https://acme.odoo.com')).toBeVisible();
  expect(calls.verify).toHaveLength(0);
});

test('an Odoo below 19 offers the JSON-RPC setup, prefilled, and the draft is deleted once that one is saved', async ({ page }) => {
  const calls = await setup(page, {
    verify: {
      ok: false,
      kind: 'not_found',
      status: 404,
      message: 'This Odoo is version 17.0, older than 19, so it has no JSON-2 API. Use the Odoo 14-18 (JSON-RPC) connector instead.',
      suggest: 'odoo-jsonrpc',
      suggestName: 'Odoo 14-18 (JSON-RPC)',
      switchTo: { slug: 'odoo-jsonrpc', name: 'Odoo 14-18 (JSON-RPC)', prefill: { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme' } },
    },
    draft: {
      id: 'c-draft',
      setupStatus: 'needs_input',
      config: { adapterSlug: 'odoo' },
      envVars: { ODOO_URL: 'https://acme.odoo.com', ODOO_DB: 'acme', ODOO_API_KEY: '' },
      maskedEnvVars: [],
    },
  });
  await page.goto('/connectors/setup/odoo?connector=c-draft&from=claude');
  await expect(page.getByLabel('Odoo address')).toHaveValue('https://acme.odoo.com');
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and save' }).click();

  const switchLink = page.getByRole('link', { name: 'Switch to Odoo 14-18 (JSON-RPC)' });
  await expect(switchLink).toBeVisible();
  const href = await switchLink.getAttribute('href');
  const target = new URL(href!, 'http://localhost');
  expect(target.pathname).toBe('/connectors/setup/odoo-jsonrpc');
  expect(Object.fromEntries(target.searchParams)).toEqual({
    'prefill.ODOO_URL': 'https://acme.odoo.com',
    'prefill.ODOO_DB': 'acme',
    from: 'claude',
    replaces: 'c-draft',
  });
  expect(href).not.toContain('typed-key');

  await switchLink.click();
  await expect(page).toHaveURL(/\/connectors\/setup\/odoo-jsonrpc\?/);
  await expect(page.getByLabel('Odoo address')).toHaveValue('https://acme.odoo.com');
  await expect(page.getByLabel('Database name')).toHaveValue('acme');
  await expect(page.getByLabel('API key')).toHaveValue('');
  await page.getByLabel('User ID').fill('2');
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect.poll(() => calls.imports.length).toBe(1);
  expect(calls.imports[0].url).toMatch(/\/api\/adapters\/odoo-jsonrpc\/import$/);
  await expect.poll(() => calls.deleted).toEqual(['c-draft']);
});

test('a draft that is ready, or of the same adapter, is kept', async ({ page }) => {
  const calls = await setup(page, {
    draft: { id: 'c-draft', setupStatus: 'ready', config: { adapterSlug: 'odoo' }, envVars: {}, maskedEnvVars: [] },
  });
  await page.goto('/connectors/setup/odoo-jsonrpc?prefill.ODOO_URL=https%3A%2F%2Facme.odoo.com&prefill.ODOO_DB=acme&replaces=c-draft');
  await page.getByLabel('User ID').fill('2');
  await page.getByLabel('API key').fill('typed-key');
  await page.getByRole('button', { name: 'Check and install' }).click();
  await expect.poll(() => calls.imports.length).toBe(1);
  // The draft is read, and left alone.
  await page.waitForTimeout(300);
  expect(calls.deleted).toEqual([]);
});
