import { expect, test } from '@playwright/test';

/**
 * Install links (/connectors/store?install=<slug>) are published in READMEs,
 * guides and satellite repositories, so most people open them signed out.
 * The sign-in redirect used to carry only the pathname, and the adapter to
 * install was lost on the way through /login.
 */
test('a signed-out install link keeps its query string through /login', async ({ page }) => {
  await page.route(/\/(api|health)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/connectors/store?install=weclapp');
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('redirect')).toBe('/connectors/store?install=weclapp');
});

/**
 * The marketing site's Install buttons append the visitor's attribution
 * (`amcp_src`, `amcp_lt`, campaign tags, Google Ads click ids). The sign-up
 * page reads those only at the top of its own URL, so inside `redirect` they
 * were lost and the sign-up was recorded as direct.
 */
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const FIRST = { utm_source: 'google', utm_medium: 'organic', landing_path: '/guides/weclapp', ts: 1, captured_on: 'site' };
const LAST = { referrer_host: 'chatgpt.com', landing_path: '/marketplace/weclapp', ts: 2, captured_on: 'site' };
const SRC = b64url(FIRST);
const LT = b64url(LAST);

test.describe('sign-in redirect with attribution', () => {
  test('moves attribution to the top of /login and keeps the rest in redirect', async ({ request }) => {
    const res = await request.get(
      `/connectors/store?install=weclapp&amcp_src=${SRC}&amcp_lt=${LT}&utm_source=site&utm_campaign=install&gclid=Cj0-abc&oppref=op_9f.Z~1&fbclid=fb1`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(307);
    const login = new URL(res.headers()['location'], 'http://x');
    expect(login.pathname).toBe('/login');
    const q = login.searchParams;
    expect(q.get('amcp_src')).toBe(SRC);
    expect(q.get('amcp_lt')).toBe(LT);
    expect(q.get('utm_source')).toBe('site');
    expect(q.get('utm_campaign')).toBe('install');
    expect(q.get('gclid')).toBe('Cj0-abc');
    expect(q.get('oppref')).toBe('op_9f.Z~1');
    // Not read by the sign-up page, so left where it was.
    expect(q.has('fbclid')).toBe(false);
    expect(q.get('redirect')).toBe('/connectors/store?install=weclapp&fbclid=fb1');
  });

  test('a path with nothing but attribution redirects to the bare path', async ({ request }) => {
    const res = await request.get(`/connectors/store?amcp_src=${SRC}`, { maxRedirects: 0 });
    const login = new URL(res.headers()['location'], 'http://x');
    expect(login.searchParams.get('redirect')).toBe('/connectors/store');
    expect(login.searchParams.get('amcp_src')).toBe(SRC);
  });

  test('a signed-in visitor goes straight to the page, query untouched', async ({ request }) => {
    const res = await request.get(`/connectors/store?install=weclapp&amcp_src=${SRC}`, {
      maxRedirects: 0,
      headers: { cookie: 'amcp_token=t' },
    });
    expect(res.status()).toBe(200);
  });

  test('the sign-up after an install link carries the hand-over', async ({ page }) => {
    let body: { attribution?: unknown } | null = null;
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/health/server-info') {
        return route.fulfill({
          json: { deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] },
        });
      }
      if (p === '/api/auth/register') {
        body = route.request().postDataJSON();
        return route.fulfill({ status: 201, json: { verificationRequired: true, message: 'Check your inbox.' } });
      }
      if (p === '/api/auth/login') return route.fulfill({ status: 401, json: { statusCode: 401, message: 'no' } });
      return route.fulfill({ json: {} });
    });

    await page.goto(`/connectors/store?install=weclapp&amcp_src=${SRC}&amcp_lt=${LT}`);
    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe('/connectors/store?install=weclapp');

    await page.getByRole('button', { name: 'Register' }).click();
    await page.locator('#auth-name').fill('Jane');
    await page.locator('#auth-email').fill('jane@example.test');
    await page.locator('#auth-password').fill('Str0ng#Passw0rd');
    await page.locator('#auth-confirm-password').fill('Str0ng#Passw0rd');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Start free trial/ }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

    expect(body).not.toBeNull();
    expect(body!.attribution).toEqual({ first_touch: FIRST, last_touch: LAST });
  });
});

/**
 * ChatGPT Ads land with `utm_source=chatgpt_ads` and OpenAI's click reference
 * `oppref`. The reference is kept only with marketing consent, and never makes
 * the touch a Google Ads click (`paid`).
 */
test.describe('ChatGPT Ads click reference on the sign-up page', () => {
  async function registerFrom(page: import('@playwright/test').Page, url: string) {
    let body: { attribution?: { first_touch?: Record<string, unknown> } } | null = null;
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/health/server-info') {
        return route.fulfill({
          json: { deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] },
        });
      }
      if (p === '/api/auth/register') {
        body = route.request().postDataJSON();
        return route.fulfill({ status: 201, json: { verificationRequired: true, message: 'Check your inbox.' } });
      }
      if (p === '/api/auth/login') return route.fulfill({ status: 401, json: { statusCode: 401, message: 'no' } });
      return route.fulfill({ json: {} });
    });
    await page.goto(url);
    await page.locator('#auth-name').fill('Jane');
    await page.locator('#auth-email').fill('jane@example.test');
    await page.locator('#auth-password').fill('Str0ng#Passw0rd');
    await page.locator('#auth-confirm-password').fill('Str0ng#Passw0rd');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Start free trial/ }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    expect(body).not.toBeNull();
    return body!.attribution!.first_touch!;
  }

  const LANDING = '/login?mode=register&utm_source=chatgpt_ads&utm_medium=cpc&utm_campaign=odoo_de&oppref=op_9f.Z~1';

  test('kept with marketing consent', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'cc_cookie',
        value: encodeURIComponent(JSON.stringify({ categories: ['necessary', 'analytics', 'marketing'] })),
        url: test.info().project.use.baseURL ?? 'http://localhost:3100',
      },
    ]);
    const touch = await registerFrom(page, LANDING);
    expect(touch).toMatchObject({ utm_source: 'chatgpt_ads', utm_medium: 'cpc', oppref: 'op_9f.Z~1', ad_consent: 'granted' });
    expect(touch).not.toHaveProperty('paid');
  });

  test('dropped without it', async ({ page }) => {
    const touch = await registerFrom(page, LANDING);
    expect(touch).toMatchObject({ utm_source: 'chatgpt_ads', ad_consent: 'unknown' });
    expect(touch).not.toHaveProperty('oppref');
    expect(touch).not.toHaveProperty('paid');
  });
});
