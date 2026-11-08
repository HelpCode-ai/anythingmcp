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
  client: 'Claude' | 'ChatGPT' | 'Cursor' | 'Copilot' | null;
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

async function publicPage(page: Page, views: View[] | 404, opts: { signedIn?: boolean } = {}) {
  const posted: unknown[] = [];
  const events: Array<Record<string, unknown>> = [];
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
    if (p.startsWith('/api/license/reactivate/') && p.endsWith('/event') && req.method() === 'POST') {
      events.push(req.postDataJSON());
      return route.fulfill({ status: 204 });
    }
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
    if (p.endsWith('/users/me')) {
      if (opts.signedIn) return json({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'ADMIN' });
      return json({ message: 'Unauthorized' }, 401);
    }
    return json({});
  });
  await page.context().route('https://checkout.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe stub</h1>' }),
  );
  return { posted, events };
}

test.describe('reactivation link (cloud, signed out)', () => {
  test('shows the workspace, the plans and the trust panel, and opens checkout without a sign-in', async ({ page }) => {
    const { posted } = await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where Claude left off' })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/reactivate\/tok_abc$/);
    await expect(page.getByText('Acme Logistics')).toBeVisible();
    await expect(page.getByText(/Your free trial ended on 4 November\./)).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    const trust = page.getByTestId('reactivate-trust');
    await expect(trust).toContainText('1,200+');
    await expect(trust).toContainText('workspaces on AnythingMCP Cloud');
    await expect(trust).toContainText('2M+');
    await expect(trust).toContainText('AI tool calls last month');
    // A Claude workspace sees Claude's listing only, and its paused connection.
    await expect(trust).toContainText('Listed in the Claude Directory');
    await expect(trust).not.toContainText('ChatGPT Plugin Directory');
    await expect(page.getByTestId('client-paused')).toHaveText(/Claude connection paused/);
    // Signed out: the nav offers a sign-in that comes back to the dashboard.
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?redirect=%2F');
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

  test('on a phone the subscribe button is on the first screen, the explanation below it', async ({ page }) => {
    // 390×664: an iPhone's visible area in Safari, toolbars included.
    await page.setViewportSize({ width: 390, height: 664 });
    await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    const cta = page.getByRole('button', { name: 'Subscribe to Starter' });
    await expect(cta).toBeInViewport({ ratio: 1, timeout: 15_000 });
    const lead = page.getByTestId('reactivate-lead');
    await expect(lead).toContainText('Your free trial ended on 4 November.');
    const [ctaBox, leadBox] = [await cta.boundingBox(), await lead.boundingBox()];
    expect(leadBox!.y).toBeGreaterThan(ctaBox!.y);
    if (process.env.REACTIVATE_SHOT) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-390-fold.png` });
      await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-390-full.png`, fullPage: true });
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-375-fold.png` });
      await page.getByRole('radio', { name: /Yearly/ }).click();
      await page.setViewportSize({ width: 390, height: 664 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-390-yearly.png` });
    }
  });

  test('on a desktop the explanation stays above the plans', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    const cta = page.getByRole('button', { name: 'Subscribe to Starter' });
    await expect(cta).toBeInViewport({ ratio: 1, timeout: 15_000 });
    const [ctaBox, leadBox] = [await cta.boundingBox(), await page.getByTestId('reactivate-lead').boundingBox()];
    expect(leadBox!.y).toBeLessThan(ctaBox!.y);
  });

  test('someone already signed in is offered their workspace, not a sign-in', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('amcp_token', 'test-token');
      localStorage.setItem('amcp_user', JSON.stringify({ id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'ADMIN' }));
    });
    await publicPage(page, [ENDED], { signedIn: true });
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where Claude left off' })).toBeVisible({ timeout: 15_000 });
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Open your workspace' })).toHaveAttribute('href', '/');
    await expect(banner.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  });

  test('reports its clicks as paywall_action, and a close without subscribing', async ({ page }) => {
    const { events } = await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('button', { name: 'Subscribe to Starter' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio', { name: /Team/ }).click();
    await page.getByRole('radio', { name: /Yearly/ }).click();
    await expect.poll(() => events.length).toBe(3);
    // The page is closed without a subscribe click (Playwright cannot route
    // the request a real unload sends, so the event is dispatched here), twice.
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });
    await expect.poll(() => events.length).toBe(4);
    expect(events).toEqual([
      { action: 'shown', plan: 'starter', period: 'monthly', device: 'desktop' },
      { action: 'plan_selected', plan: 'team', period: 'monthly', device: 'desktop' },
      { action: 'period_selected', plan: 'team', period: 'yearly', device: 'desktop' },
      { action: 'left_without_subscribe', plan: 'team', period: 'yearly', device: 'desktop' },
    ]);
  });

  test('a subscribe click is reported, and no leave after it', async ({ page }) => {
    const { events } = await publicPage(page, [ENDED]);
    await page.goto('/reactivate/tok_abc');
    await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Subscribe to Starter' }).click();
    await expect(page).toHaveURL(CHECKOUT);
    expect(events.map((e) => e.action)).toEqual(['shown', 'subscribe_clicked']);
  });

  test('a ChatGPT chat gets ChatGPT wording and its own directory', async ({ page }) => {
    await publicPage(page, [{ ...ENDED, client: 'ChatGPT' }]);
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where ChatGPT left off' })).toBeVisible({ timeout: 15_000 });
    const trust = page.getByTestId('reactivate-trust');
    await expect(trust).toContainText('Listed in the ChatGPT Plugin Directory');
    await expect(trust).not.toContainText('Claude Directory');
    await expect(page.getByText('Ask ChatGPT again')).toBeVisible();
  });

  test('an unknown client gets neutral wording and both directories', async ({ page }) => {
    await publicPage(page, [{ ...ENDED, client: null }]);
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where your AI left off' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('client-paused')).toHaveCount(0);
    const trust = page.getByTestId('reactivate-trust');
    await expect(trust).toContainText('Listed in the Claude Directory');
    await expect(trust).toContainText('Listed in the ChatGPT Plugin Directory');
  });

  for (const [lang, title, cta] of [
    ['de-DE', 'Machen Sie dort weiter, wo Claude aufgehört hat', 'Starter abonnieren'],
    ['it-IT', 'Riprendi da dove Claude si è fermato', 'Abbonati a Starter'],
    ['es-ES', 'Retoma donde Claude lo dejó', 'Suscribirse a Starter'],
    ['zh-CN', '让 Claude 从中断处继续', '订阅 Starter'],
    ['ja-JP', 'Claude の作業をそのまま再開', 'Starter に登録する'],
    ['ru-RU', 'Продолжите с того места, где остановился Claude', 'Подписаться на Starter'],
  ] as const) {
    test(`speaks ${lang} to a ${lang} browser`, async ({ browser }) => {
      const context = await browser.newContext({ locale: lang });
      const page = await context.newPage();
      await publicPage(page, [ENDED]);
      await page.goto('/reactivate/tok_abc');
      await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: cta })).toBeVisible();
      if (process.env.REACTIVATE_SHOT && lang === 'ja-JP') {
        await page.screenshot({ path: `${process.env.REACTIVATE_SHOT}/reactivate-ja-1440.png`, fullPage: true });
      }
      await context.close();
    });
  }

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
    await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
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
