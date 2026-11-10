import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, test, type Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import type { PlanFit } from '../../src/lib/api';
import { fitFor, formatStorage, planFitLines, selectionForFit } from '../../src/lib/card-trial';
import { PLAN_FIT_COPY } from '../../src/app/reactivate/[token]/copy';

/**
 * The "What changes with Starter" block (Cloud): what a workspace above
 * Starter would have paused or not included, shown before checkout, and the
 * swap at the plan's cap after a downgrade.
 *
 * The first block tests the pure helpers against the English messages. The
 * rest is UI smoke with the API mocked (the same fake session as the other
 * specs: seed the cookie and localStorage, stub /api/* and /health/*).
 */

const en = JSON.parse(readFileSync(join(__dirname, '../../messages/en.json'), 'utf8'));
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'planFit' });

const axis = (current: number, max: number | null) => ({ current, max, over: max != null && current > max });
const ranked = (names: string[], max: number | null, calls: number[] = []) => {
  const items = names.map((name, i) => ({ id: `${name.toLowerCase()}-id`, name, calls30d: calls[i] ?? 0 }));
  const cut = max == null ? items.length : max;
  return { ...axis(items.length, max), keep: items.slice(0, cut), pause: items.slice(cut) };
};

const NINE = ['Odoo', 'Shopify', 'Stripe', 'Gmail', 'Slack', 'Etsy', 'Notion', 'Trello', 'Asana'];
const CALLS = [420, 310, 120, 80, 33, 9, 4, 1, 0];

function starterFit(overrides: Partial<PlanFit> = {}): PlanFit {
  return {
    plan: 'starter',
    fits: false,
    connectors: ranked(NINE, 5, CALLS),
    mcpServers: ranked(['Main', 'Sales', 'Ops', 'Test'], 3, [90, 20, 5, 0]),
    users: axis(2, 1),
    fileSearch: {
      connectors: ranked(['NAS', 'Drive'], 1, [10, 2]),
      files: axis(1200, 500),
      bytes: axis(300 * 1024 * 1024, 500 * 1024 * 1024),
      fileShare: true,
    },
    code: {
      tools: axis(7, 5),
      inlineInUse: true,
      inlineIncluded: false,
      runsThisMonth: axis(120, 500),
    },
    ...overrides,
  };
}

function teamFit(): PlanFit {
  return {
    plan: 'team',
    fits: true,
    connectors: ranked(NINE, 15, CALLS),
    mcpServers: ranked(['Main', 'Sales', 'Ops', 'Test'], 10, [90, 20, 5, 0]),
    users: axis(2, 3),
    fileSearch: {
      connectors: ranked(['NAS', 'Drive'], 3, [10, 2]),
      files: axis(1200, 2000),
      bytes: axis(300 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
      fileShare: true,
    },
    code: { tools: axis(7, 20), inlineInUse: true, inlineIncluded: true, runsThisMonth: axis(120, 5000) },
  };
}

test.describe('plan-fit helpers', () => {
  test('turns a plan fit into short lines, most important first', () => {
    const lines = planFitLines(starterFit()).map((l) => tEn(`lines.${l.key}`, l.values));
    expect(lines).toEqual([
      '4 of 9 connectors paused (least used). You choose which.',
      '1 of 4 MCP servers paused (least used).',
      '1 user included, you have 2. Nobody loses access.',
      'File Search: up to 1 folder and 500 files.',
      '5 saved code tools (you have 7).',
      'No inline code (code_execute).',
    ]);
  });

  test('says "you choose" once, on the first line that pauses something', () => {
    const fit = starterFit({ connectors: ranked(['Odoo', 'Shopify'], 5) });
    const lines = planFitLines(fit).map((l) => tEn(`lines.${l.key}`, l.values));
    expect(lines[0]).toBe('1 of 4 MCP servers paused (least used). You choose which.');
  });

  test('names storage when only the bytes go past the plan', () => {
    const fit = starterFit({
      connectors: ranked(['Odoo'], 5),
      mcpServers: ranked(['Main'], 3),
      users: axis(1, 1),
      fileSearch: {
        connectors: ranked(['NAS'], 1),
        files: axis(300, 500),
        bytes: axis(1.2 * 1024 * 1024 * 1024, 500 * 1024 * 1024),
        fileShare: true,
      },
      code: { tools: axis(1, 5), inlineInUse: false, inlineIncluded: false, runsThisMonth: axis(0, 500) },
    });
    expect(planFitLines(fit).map((l) => tEn(`lines.${l.key}`, l.values))).toEqual([
      'File Search: up to 500 MB of storage.',
    ]);
  });

  test('has nothing to say when the workspace fits', () => {
    expect(planFitLines(teamFit())).toEqual([]);
    expect(planFitLines(null)).toEqual([]);
    // Inline code that is not switched on is no change.
    const quiet = starterFit({
      connectors: ranked(['Odoo'], 5),
      mcpServers: ranked(['Main'], 3),
      users: axis(1, 1),
      fileSearch: { connectors: ranked([], 1), files: axis(0, 500), bytes: axis(0, 500 * 1024 * 1024), fileShare: true },
      code: { tools: axis(0, 5), inlineInUse: false, inlineIncluded: false, runsThisMonth: axis(0, 500) },
      fits: true,
    });
    expect(planFitLines(quiet)).toEqual([]);
  });

  test('every page language of the reactivation page words every line', () => {
    const lines = planFitLines(starterFit());
    for (const [lang, copy] of Object.entries(PLAN_FIT_COPY)) {
      const t = createTranslator({ locale: lang, messages: { planFit: copy }, namespace: 'planFit' });
      for (const l of lines) {
        const text = t(`lines.${l.key}`, l.values);
        expect(text, `${lang} ${l.key}`).not.toContain('{');
        expect(text, `${lang} ${l.key}`).not.toMatch(/[—–]/);
      }
    }
    const tAnon = createTranslator({ locale: 'en', messages: { planFit: PLAN_FIT_COPY.en }, namespace: 'planFit' });
    expect(tAnon('lines.connectors', { paused: 4, total: 9, max: 5 })).toBe(
      '4 of 9 connectors paused (least used). You choose which after signing in.',
    );
  });

  test('preselects Team when Starter does not fit and Team does', () => {
    const plans = { starter: starterFit(), team: teamFit() };
    expect(selectionForFit({ plan: 'starter', period: 'yearly' }, plans)).toEqual({ plan: 'team', period: 'yearly' });
    expect(selectionForFit({ plan: 'team', period: 'monthly' }, plans)).toEqual({ plan: 'team', period: 'monthly' });
    // No answer, or past Team too: the selection stays.
    expect(selectionForFit({ plan: 'starter', period: 'monthly' }, null)).toEqual({ plan: 'starter', period: 'monthly' });
    expect(
      selectionForFit({ plan: 'starter', period: 'monthly' }, { starter: starterFit(), team: { ...teamFit(), fits: false } }),
    ).toEqual({ plan: 'starter', period: 'monthly' });
    expect(fitFor({}, 'starter')).toBeNull();
  });

  test('formats storage like the plans state it', () => {
    expect(formatStorage(500 * 1024 * 1024)).toBe('500 MB');
    expect(formatStorage(2 * 1024 * 1024 * 1024)).toBe('2 GB');
    expect(formatStorage(1.25 * 1024 * 1024 * 1024)).toBe('1.3 GB');
    expect(formatStorage(0)).toBe('0 B');
  });
});

// ── UI smoke ────────────────────────────────────────────────────────────────

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

type Usage = {
  plan: string;
  connectors: { current: number; max: number | null; isOver: boolean };
  mcpServers: { current: number; max: number | null; isOver: boolean };
  users: { current: number; max: number | null; isOver: boolean };
  isOverAny: boolean;
  pausedByPlan?: { connectors: string[]; mcpServers: string[] };
};

async function cloudSession(
  page: Page,
  opts: {
    license: Record<string, unknown>;
    usage: Usage;
    planFit?: Record<string, PlanFit> | null;
    connectors?: Array<Record<string, unknown>>;
    wall?: Record<string, unknown> | null;
  },
) {
  const events: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const updates: Array<{ id: string; body: unknown }> = [];
  const connectorList = opts.connectors ?? [];
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
    localStorage.setItem('amcp_card_trial_prompt:u1', 'shown');
  }, ADMIN);
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p === '/api/price-estimate') return json({ currency: null, vat: true });
    if (p.endsWith('/product-events') && req.method() === 'POST') {
      events.push(req.postDataJSON());
      return route.fulfill({ status: 204 });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-10-01' });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/status')) return json(opts.license);
    if (p.endsWith('/license/usage')) return json(opts.usage);
    if (p.endsWith('/license/plan-fit')) {
      if (opts.planFit === null) return json({ message: 'Not Found' }, 404);
      const plan = new URL(req.url()).searchParams.get('plan');
      const plans = opts.planFit ?? {};
      return json({ plans: plan ? { [plan]: plans[plan] } : plans });
    }
    if (p.endsWith('/license/wall')) return json({ wall: opts.wall ?? null });
    if (p.endsWith('/license/card-trial-eligibility')) return json({ kind: 'trial', trialEndsAt: null });
    if (p.endsWith('/organizations/mine')) return json([{ id: 'o1', name: 'Main', role: 'ADMIN', joinedAt: '2026-10-01' }]);
    if (p.endsWith('/organizations/current')) return json({ id: 'o1', name: 'Main', createdAt: '2026-10-01' });
    const one = /\/api\/connectors\/([^/]+)$/.exec(p);
    if (one && req.method() === 'PUT') {
      const body = req.postDataJSON();
      updates.push({ id: one[1], body });
      const c = connectorList.find((x) => x.id === one[1]);
      if (c) Object.assign(c, body);
      return json({});
    }
    if (p === '/api/connectors') return json(connectorList);
    if (p.endsWith('/adapters/starter-pack')) return json([]);
    if (p.endsWith('/adapters')) return json([]);
    return json({});
  });
  return { events, updates };
}

const ENDED = { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() - 86_400_000).toISOString(), trialDaysLeft: 0, features: {} };
const TRIAL_USAGE: Usage = {
  plan: 'trial',
  connectors: { current: 9, max: 15, isOver: false },
  mcpServers: { current: 4, max: 10, isOver: false },
  users: { current: 2, max: 3, isOver: false },
  isOverAny: false,
};

test.describe('plan fit on the paywall (cloud)', () => {
  test('the ended-trial wall says what Starter would change, and Team fits', async ({ page }) => {
    const { events } = await cloudSession(page, {
      license: ENDED,
      usage: TRIAL_USAGE,
      planFit: { starter: starterFit(), team: teamFit() },
      wall: { variant: 'trust', recap: null },
    });
    await page.goto('/connectors');
    await expect(page.getByRole('heading', { name: 'Keep your AI connected to your apps' })).toBeVisible({ timeout: 15_000 });
    // Above Starter: Team is preselected, and says it fits.
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('plan-fit-fits')).toHaveText('Everything you use today fits Team.');

    // Starter stays selectable, and says what it changes.
    await page.getByRole('radio', { name: /Starter/ }).click();
    const notice = page.getByTestId('plan-fit-notice');
    await expect(notice).toContainText('What changes with Starter');
    await expect(notice).toContainText('4 of 9 connectors paused (least used). You choose which.');
    await expect(notice).toContainText('No inline code (code_execute).');
    const cta = page.getByRole('button', { name: 'Subscribe to Starter' });
    await expect(cta).toBeEnabled();
    // The subscribe button comes first; the notice sits under it.
    const [ctaBox, noticeBox] = await Promise.all([cta.boundingBox(), notice.boundingBox()]);
    expect(ctaBox!.y).toBeLessThan(noticeBox!.y);

    await notice.getByRole('button', { name: 'See which ones' }).click();
    const details = page.getByTestId('plan-fit-details');
    await expect(details).toContainText('Odoo');
    await expect(details).toContainText('Paused: Etsy');
    await expect(details).not.toContainText('calls');
    await expect(details).toContainText('Trello');

    if (process.env.PLAN_FIT_SHOT) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${process.env.PLAN_FIT_SHOT}/wall-plan-fit.png`, fullPage: true });
    }

    // Team is one click away.
    await notice.getByRole('button', { name: 'Choose Team instead' }).click();
    await expect(page.getByRole('radio', { name: /Team/ })).toHaveAttribute('aria-checked', 'true');

    const actions = events.filter((e) => e.event === 'paywall_action').map((e) => e.metadata?.action);
    expect(actions).toContain('plan_fit_shown');
    expect(actions).toContain('plan_fit_details_opened');
    const shown = events.find((e) => e.metadata?.action === 'plan_fit_shown');
    expect(shown?.metadata).toMatchObject({ source: 'trial_ended_wall', plan: 'starter' });
  });

  test('without a plan-fit answer the wall shows no block', async ({ page }) => {
    await cloudSession(page, { license: ENDED, usage: TRIAL_USAGE, planFit: null, wall: { variant: 'trust', recap: null } });
    await page.goto('/connectors');
    await expect(page.getByRole('heading', { name: 'Keep your AI connected to your apps' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio', { name: /Starter/ }).click();
    await expect(page.getByTestId('plan-fit-notice')).toHaveCount(0);
  });
});

test.describe('swap at the plan cap (cloud)', () => {
  test('a connector paused by the plan is marked, and activating it at the cap opens the swap', async ({ page }) => {
    const active = NINE.slice(0, 5).map((name) => ({
      id: `${name.toLowerCase()}-id`,
      name,
      type: 'REST',
      isActive: true,
      baseUrl: `https://${name.toLowerCase()}.example.test`,
      tools: [],
    }));
    const paused = { id: 'etsy-id', name: 'Etsy', type: 'REST', isActive: false, baseUrl: 'https://etsy.example.test', tools: [] };
    const fit = starterFit({ connectors: ranked(NINE.slice(0, 5), 5, CALLS) });
    const { updates } = await cloudSession(page, {
      license: { plan: 'starter', status: 'active', expiresAt: null, features: {} },
      usage: {
        plan: 'starter',
        connectors: { current: 5, max: 5, isOver: false },
        mcpServers: { current: 1, max: 3, isOver: false },
        users: { current: 1, max: 1, isOver: false },
        isOverAny: false,
        pausedByPlan: { connectors: ['etsy-id'], mcpServers: [] },
      },
      planFit: { starter: fit },
      connectors: [...active, paused],
    });
    await page.goto('/connectors');
    await expect(page.getByTestId('usage-banner-paused')).toContainText('1 connector is paused by your plan.', { timeout: 15_000 });
    const card = page.locator('div.group', { hasText: 'Etsy' });
    await expect(card.getByTestId('paused-by-plan')).toHaveText('Paused: plan limit');
    await card.hover();
    await card.getByRole('button', { name: 'Activate' }).click();

    const dialog = page.getByTestId('plan-swap-dialog');
    await expect(dialog).toContainText('Your plan includes 5 active connectors');
    await expect(dialog).toContainText('Pause one to activate Etsy.');
    // Most used first; the least used is preselected.
    const options = dialog.getByRole('radio');
    await expect(options).toHaveCount(5);
    await expect(options.first()).toContainText('Odoo');
    await expect(options.last()).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('link', { name: 'Upgrade to Team' })).toBeVisible();

    if (process.env.PLAN_FIT_SHOT) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.PLAN_FIT_SHOT}/swap-dialog.png` });
    }

    await dialog.getByRole('button', { name: 'Pause and activate' }).click();
    await expect(dialog).toHaveCount(0);
    expect(updates).toEqual([
      { id: 'slack-id', body: { isActive: false } },
      { id: 'etsy-id', body: { isActive: true } },
    ]);
  });
});

test.describe('plan fit elsewhere (cloud)', () => {
  test('Settings → License shows usage meters against the plan, and what Starter changes', async ({ page }) => {
    const { events } = await cloudSession(page, {
      license: { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), trialDaysLeft: 2, features: {} },
      usage: TRIAL_USAGE,
      planFit: { starter: starterFit(), team: teamFit() },
    });
    await page.goto('/settings/license');
    const meters = page.getByTestId('plan-usage');
    await expect(meters).toContainText('Usage in your trial (Team limits)', { timeout: 15_000 });
    await expect(meters.getByRole('meter', { name: 'Connectors' })).toHaveAttribute('aria-valuenow', '9');
    await expect(meters).toContainText('9 / 15');
    await expect(meters).toContainText('1,200 / 2,000');
    await meters.getByRole('button', { name: 'See what changes with Starter' }).click();
    await expect(meters.getByTestId('plan-fit-notice')).toContainText('What changes with Starter');
    // The trial banner, in the last 3 days, links to the same block.
    await expect(page.getByText('Your trial includes everything in Team.')).toBeVisible();
    await page.getByRole('button', { name: 'Above Starter: see what changes' }).click();
    await expect(page.getByRole('dialog')).toContainText('4 of 9 connectors paused');
    if (process.env.PLAN_FIT_SHOT) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.PLAN_FIT_SHOT}/trial-banner-dialog.png` });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await meters.scrollIntoViewIfNeeded();
      await meters.screenshot({ path: `${process.env.PLAN_FIT_SHOT}/license-meters.png` });
    }
    const sources = events.filter((e) => e.metadata?.action === 'plan_fit_shown').map((e) => e.metadata?.source);
    expect(sources).toEqual(expect.arrayContaining(['license_page', 'trial_banner']));
  });

  test('the reactivation page gives counts only, in its own words', async ({ page }) => {
    const anon = (fit: PlanFit): PlanFit => {
      const strip = (r: PlanFit['connectors']) => ({
        ...r,
        keep: r.keep.map((x, i) => ({ id: `keep-${i}`, name: '', calls30d: x.calls30d })),
        pause: r.pause.map((x, i) => ({ id: `pause-${i}`, name: '', calls30d: x.calls30d })),
      });
      return { ...fit, connectors: strip(fit.connectors), mcpServers: strip(fit.mcpServers), fileSearch: { ...fit.fileSearch, connectors: strip(fit.fileSearch.connectors) } };
    };
    const events: Array<Record<string, unknown>> = [];
    await page.route(/\/(api|health)\//, async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (p === '/health/server-info') {
        return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
      }
      if (p.endsWith('/event') && req.method() === 'POST') {
        events.push(req.postDataJSON());
        return route.fulfill({ status: 204 });
      }
      if (p.startsWith('/api/license/reactivate/')) {
        return json({
          state: 'trial-ended',
          workspaceName: 'Acme Logistics',
          trialEndedAt: '2026-11-04T12:00:00.000Z',
          client: 'Claude',
          usage: { connectors: 9, mcpServers: 4, users: 2 },
          planFit: { starter: anon(starterFit()), team: anon(teamFit()) },
        });
      }
      if (p.endsWith('/users/me')) return json({ message: 'Unauthorized' }, 401);
      return json({});
    });
    await page.goto('/reactivate/tok_abc');
    await expect(page.getByRole('heading', { name: 'Pick up where Claude left off' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('plan-fit-fits')).toHaveText('Everything you use today fits Team.');
    await page.getByRole('radio', { name: /Starter/ }).click();
    const notice = page.getByTestId('plan-fit-notice');
    await expect(notice).toContainText('4 of 9 connectors paused (least used). You choose which after signing in.');
    const cta = page.getByRole('button', { name: /Subscribe to Starter/ });
    const [ctaBox, noticeBox] = await Promise.all([cta.boundingBox(), notice.boundingBox()]);
    expect(ctaBox!.y).toBeLessThan(noticeBox!.y);
    await expect(notice.getByRole('button', { name: 'See which ones' })).toHaveCount(0);
    if (process.env.PLAN_FIT_SHOT) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.PLAN_FIT_SHOT}/reactivate-plan-fit.png`, fullPage: true });
    }
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'plan_fit_shown', plan: 'starter' })]));
  });
});
