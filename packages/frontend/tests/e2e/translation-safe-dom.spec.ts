import { expect, test, type Page } from '@playwright/test';

/**
 * A browser that translates the page rewrites the DOM under React. The guard
 * inlined in <head> (lib/translation-safe-dom.ts) keeps the app working.
 *
 * Each case runs twice: once as served, and once with the guard unable to
 * install itself, which must still crash. Without that control a change to the
 * page could leave the reproduction testing nothing.
 *
 * - Text nodes: what Google Translate does, wrapping each text node in
 *   <font><font>…</font></font>, then a filter chip whose label React removes
 *   (ANYTHINGMCP-CLOUD-FRONTEND-3).
 * - <body>: another script takes <body> out of <html>, then a navigation
 *   (ANYTHINGMCP-CLOUD-FRONTEND-T/-V on /login, -X on /settings: React's
 *   "expected a <body> element", then "Cannot read properties of null
 *   (reading 'removeChild')").
 */

const USER = { id: 'u1', email: 'test@example.com', name: 'Test User', role: 'ADMIN', organizationId: 'o1', emailVerified: true };

const ADAPTERS = [
  { slug: 'acme-crm', name: 'Acme CRM', description: 'Contacts and deals.', category: 'crm', region: 'intl', toolCount: 3, authType: 'API_KEY', docsUrl: '', icon: '', requiredEnvVars: [] },
  { slug: 'acme-mail', name: 'Acme Mail', description: 'Newsletters.', category: 'marketing', region: 'intl', toolCount: 2, authType: 'API_KEY', docsUrl: '', icon: '', requiredEnvVars: [] },
];

async function fakeSession(page: Page, { guard }: { guard: boolean }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // A render error the error boundary caught is only logged.
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && m.text().startsWith('[AnythingMCP]')) warnings.push(m.text());
  });

  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);
  await page.route(/\/(api|health)\//, (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'self-hosted', mcpAuthMode: 'both', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p.endsWith('/users/me')) return json(USER);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (p.endsWith('/license/status')) return json({ plan: 'community', status: 'active' });
    if (p.endsWith('/audit/stats')) return json({ invocations24h: 0, errors24h: 0 });
    if (p.endsWith('/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 0, successRate: 100, avgDuration: 0 });
    if (p === '/api/adapters') return json(ADAPTERS);
    return json([]);
  });

  if (!guard) {
    // The control: the inline guard runs but cannot install anything. Its
    // assignments to the read-only DOM methods are ignored (it is not strict
    // code), and MutationObserver is missing while <head> is parsed.
    await page.addInitScript(() => {
      for (const name of ['removeChild', 'insertBefore'] as const) {
        Object.defineProperty(Node.prototype, name, { value: Node.prototype[name], writable: false, configurable: true });
      }
      const Observer = window.MutationObserver;
      Object.defineProperty(window, 'MutationObserver', {
        configurable: true,
        get: () => (document.body ? Observer : undefined),
      });
    });
  }
  return { errors, warnings };
}

/** The errors these cases are about; a 404 for an icon is not one. */
const isDomError = (message: string) => /removeChild|insertBefore|not a child|<body>/i.test(message);

/** What Google Translate does to every text node it translates. */
async function translate(page: Page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const parent = n.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|FONT)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const outer = document.createElement('font');
      const inner = document.createElement('font');
      outer.style.verticalAlign = inner.style.verticalAlign = 'inherit';
      inner.textContent = `${text.nodeValue}`.toUpperCase();
      outer.appendChild(inner);
      text.parentNode!.insertBefore(outer, text);
      text.parentNode!.removeChild(text);
    }
    return texts.length;
  });
}

/** Translate the marketplace with a category picked, then unpick it. */
async function unpickTranslatedCategory(page: Page) {
  await page.goto('/connectors/store');
  const summary = page.locator('p', { hasText: /^2 adapters$/ });
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Marketing/ }).click();
  // React appends " · Marketing" to the summary as its own text node.
  await expect(page.locator('p', { hasText: /^1 of 2 adapters · Marketing$/ })).toBeVisible();

  expect(await translate(page)).toBeGreaterThan(10);
  // Unpicking removes that text node, which the translator has replaced.
  await page.getByRole('button', { name: /^MARKETING/ }).click();
}

/** Open /settings, take <body> out of <html>, go back to the dashboard. */
async function navigateWithoutBody(page: Page, how: 'remove' | 'wrap') {
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.waitForURL(/\/settings$/);
  await page.waitForLoadState('networkidle');
  await page.evaluate((mode) => {
    const body = document.body;
    if (mode === 'remove') {
      body.parentNode!.removeChild(body);
    } else {
      const wrapper = document.createElement('font');
      body.parentNode!.insertBefore(wrapper, body);
      wrapper.appendChild(body);
    }
  }, how);
  // Two ticks: the guard puts <body> back in a microtask.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await page.evaluate(() => history.back());
  await page.waitForURL((url) => url.pathname === '/');
}

test.describe('page translated by the browser', () => {
  test('control: without the guard, unpicking a translated filter breaks the page', async ({ page }) => {
    const { errors } = await fakeSession(page, { guard: false });
    await unpickTranslatedCategory(page);
    await expect(page.getByText('Something went wrong')).toBeVisible();
    expect(errors.some(isDomError)).toBe(true);
  });

  test('unpicking a translated filter keeps the page working', async ({ page }) => {
    const { errors, warnings } = await fakeSession(page, { guard: true });
    await unpickTranslatedCategory(page);
    // The filter applied: both adapters are listed again.
    await expect(page.getByText('ACME CRM').or(page.getByText('Acme CRM')).first()).toBeVisible();
    await expect(page.getByText('Acme Mail').or(page.getByText('ACME MAIL')).first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    expect(errors.filter(isDomError)).toEqual([]);
    // Visible to whoever debugs the page, as a warning.
    expect(warnings.some((w) => w.includes('removeChild skipped'))).toBe(true);
  });
});

test.describe('<body> taken out of <html> by another script', () => {
  test('control: without the guard, the next navigation throws', async ({ page }) => {
    const { errors } = await fakeSession(page, { guard: false });
    await navigateWithoutBody(page, 'remove');
    await expect.poll(() => errors.join('\n')).toContain("Cannot read properties of null (reading 'removeChild')");
    expect(errors.join('\n')).toContain('React expected a <body> element');
  });

  for (const how of ['remove', 'wrap'] as const) {
    test(`navigation still works after a script ${how === 'remove' ? 'removes' : 'wraps'} <body>`, async ({ page }) => {
      const { errors, warnings } = await fakeSession(page, { guard: true });
      await navigateWithoutBody(page, how);
      expect(await page.evaluate(() => document.body?.parentElement === document.documentElement)).toBe(true);
      // The dashboard rendered in place of /settings.
      await expect(page.getByText('Invocations · 24h')).toBeVisible();
      expect(errors.filter(isDomError)).toEqual([]);
      expect(warnings.some((w) => w.includes('<body> put back'))).toBe(true);
    });
  }
});
