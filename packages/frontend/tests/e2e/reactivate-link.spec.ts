import { expect, test, type Page } from '@playwright/test';

/**
 * /reactivate/<token>: the page an AI client links to when a tool call is
 * refused because the workspace's trial ended. No sign-in: the token names the
 * workspace, the page sells the plans and opens Stripe Checkout for it.
 */

type View = {
  state: 'trial-ended' | 'active' | 'payment-failed' | 'no-license';
  workspaceName: string;
  trialEndedAt: string | null;
  client: 'Claude' | 'ChatGPT' | null;
  usage: { connectors: number; mcpServers: number; users: number };
};

const ENDED: View = {
  state: 'trial-ended',
  workspaceName: 'Acme Logistics',
  trialEndedAt: '2026-11-04T12:00:00.000Z',
  client: 'Claude',
  usage: { connectors: 3, mcpServers: 1, users: 1 },
};

const CHECKOUT = 'https://checkout.example.test/pay/cs_1';

async function publicPage(page: Page, views: View[] | 404) {
  const posted: unknown[] = [];
  let gets = 0;
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/public/stats')) return json({ workspaces: 1250, dockerPulls: 250_000, toolCalls30d: 2_000_000 });
    if (p.startsWith('/api/license/reactivate/') && req.method() === 'POST') {
      posted.push(req.postDataJSON());
      return json({ url: CHECKOUT });
    }
    if (p.startsWith('/api/license/reactivate/')) {
      if (views === 404) return json({ message: 'This link is not valid any more.' }, 404);
      const v = views[Math.min(gets, views.length - 1)];
      gets += 1;
      return json(v);
    }
    // Nobody is signed in on this page.
    if (p.endsWith('/users/me')) return json({ message: 'Unauthorized' }, 401);
    return json({});
  });
  await page.context().route('https://checkout.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe stub</h1>' }),
  );
  return { posted };
}

test.describe('reactivation link (cloud, signed out)', () => {
  test('shows the workspace, the plans and the trust panel, and opens checkout without a sign-in', async ({ page }) => {
    const { posted } = await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where Claude left off' })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/reactivate\/tok_abc$/);
    await expect(page.getByText('Acme Logistics')).toBeVisible();
    await expect(page.getByText(/Your free trial ended on (4 November|November 4)\./)).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    await expect(page.getByText('1,200+ workspaces on AnythingMCP Cloud.')).toBeVisible();
    // No usage numbers are shown.
    await expect(page.getByText(/successful call/)).toHaveCount(0);
    if (process.env.REACTIVATE_SHOT) {
      const dir = process.env.REACTIVATE_SHOT;
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${dir}/reactivate-1440.png`, fullPage: true });
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/reactivate-1366-fold.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/reactivate-390-fold.png` });
      await page.screenshot({ path: `${dir}/reactivate-390-full.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole('radio', { name: /Yearly/ }).click();
    await page.getByRole('button', { name: 'Subscribe to Starter' }).click();
    await expect(page).toHaveURL(CHECKOUT);
    expect(posted).toEqual([{ plan: 'starter', billingPeriod: 'yearly' }]);
  });

  test('preselects Team for a workspace that outgrew Starter', async ({ page }) => {
    const { posted } = await publicPage(page, [{ ...ENDED, usage: { connectors: 8, mcpServers: 2, users: 1 } }]);
    await page.goto('/reactivate/tok_abc');
    await page.getByRole('button', { name: 'Subscribe to Team' }).click({ timeout: 15_000 });
    await expect(page).toHaveURL(CHECKOUT);
    expect(posted).toEqual([{ plan: 'team', billingPeriod: 'monthly' }]);
  });

  test('an expired or unknown link offers a sign-in', async ({ page }) => {
    await publicPage(page, 404);
    await page.goto('/reactivate/tok_old');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  test('back from Stripe it waits until the workspace is active', async ({ page }) => {
    // Two answers before the payment lands: React runs the first fetch twice in dev.
    await publicPage(page, [ENDED, ENDED, { ...ENDED, state: 'active' }]);
    await page.goto('/reactivate/tok_abc?paid=1');
    await expect(page.getByRole('heading', { name: 'Confirming your payment…' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: "Payment received, you're all set" })).toBeVisible({ timeout: 15_000 });
    if (process.env.REACTIVATE_SHOT) await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-paid.png` });
  });
});
