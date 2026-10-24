import { expect, test, type Page } from '@playwright/test';

/**
 * A single connector can be exported as JSON or YAML from its page, and the
 * import dialog on the connectors list accepts a .yaml file, sending its text
 * to POST /api/connectors/import for the server to parse and validate.
 */

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const CONNECTOR = {
  id: 'c1',
  name: 'Acme CRM',
  type: 'REST',
  baseUrl: 'https://api.acme.test',
  authType: 'NONE',
  authConfig: null,
  isActive: true,
  headers: {},
  maskedHeaders: [],
  envVars: {},
  maskedEnvVars: [],
  config: {},
  tools: [],
  createdAt: '2026-09-01T00:00:00Z',
  userId: 'u1',
  organizationId: 'o1',
};

const YAML_FILE = [
  'version: "1.0"',
  'exportedAt: "2026-10-21T10:00:00.000Z"',
  'secretsIncluded: false',
  'connectors:',
  '  - name: Acme CRM',
  '    type: REST',
  '    baseUrl: https://api.acme.test',
  '    tools: []',
  '',
].join('\n');

async function mockApi(page: Page, baseURL: string) {
  const exports: string[] = [];
  const imports: Record<string, any>[] = [];
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: baseURL }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/connectors/c1/export')) {
      exports.push(url);
      return route.fulfill({
        status: 200,
        contentType: 'application/yaml; charset=utf-8',
        headers: { 'Content-Disposition': 'attachment; filename="acme-crm.anythingmcp.yaml"' },
        body: YAML_FILE,
      });
    }
    if (url.endsWith('/api/connectors/import') && req.method() === 'POST') {
      imports.push(req.postDataJSON());
      return json({ message: 'Imported 1 connectors with 0 tools', created: 1, skipped: 0, tools: 0, errors: [] }, 201);
    }
    if (url.includes('/api/connectors/proxy-availability')) return json({ available: false });
    if (url.includes('/api/connectors/c1/catalog-diff')) return json({ catalogManaged: false });
    if (url.includes('/api/connectors/c1')) return json(CONNECTOR);
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([CONNECTOR]);
    return json({});
  });

  return { exports, imports };
}

test.describe('Connector export and import as YAML', () => {
  test('the Export menu downloads the connector as YAML', async ({ page, baseURL }) => {
    const { exports } = await mockApi(page, baseURL!);
    await page.goto('/connectors/c1');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export as YAML' }).click();

    expect((await download).suggestedFilename()).toBe('acme-crm.anythingmcp.yaml');
    expect(exports).toHaveLength(1);
    expect(new URL(exports[0]).searchParams.get('format')).toBe('yaml');
    await expect(page.getByText(/Exported as YAML without secret values/)).toBeVisible();
  });

  test('the import dialog accepts a .yaml file and sends its text', async ({ page, baseURL }) => {
    const { imports } = await mockApi(page, baseURL!);
    await page.goto('/connectors');

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const input = page.locator('input[type="file"]');
    await expect(input).toHaveAttribute('accept', /\.yaml/);
    await input.setInputFiles({
      name: 'acme-crm.anythingmcp.yaml',
      mimeType: 'application/yaml',
      buffer: Buffer.from(YAML_FILE),
    });
    await expect(page.getByLabel('Export file contents')).toHaveValue(YAML_FILE);

    await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText(/Imported 1 connectors/)).toBeVisible();
    expect(imports).toEqual([{ content: YAML_FILE }]);
  });
});
