import { test, expect, type Page } from '@playwright/test';
import type { EditionState } from '../../src/lib/api';

/**
 * Business was retired on 8 Oct 2026. Self-hosted, single sign-on and SCIM
 * are offered as Enterprise: a 30-day trial on the instance, then an enquiry
 * (anythingmcp.com/contact?plan=enterprise), never a checkout. On Cloud, the
 * usage nudge for a Team workspace points to the same enquiry.
 */

const ADMIN = {
  id: 'u1',
  email: 'admin@example.test',
  name: 'Ada Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

const COMMUNITY: EditionState = {
  edition: 'community',
  business: false,
  source: null,
  plan: null,
  seatLimit: 3,
  seatsUsed: 2,
  communitySeatLimit: 3,
  trialEndsAt: null,
  trialAvailable: true,
  trialDays: 30,
  transitionUntil: null,
};

async function session(
  page: Page,
  opts: {
    mode: 'cloud' | 'self-hosted';
    edition?: EditionState;
    usage?: Record<string, unknown>;
    status?: Record<string, unknown>;
    users?: unknown[];
  },
) {
  const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(user));
    localStorage.setItem('amcp_card_trial_prompt:u1', 'shown');
  }, ADMIN);
  await page.route(/\/(api|health)\//, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: opts.mode === 'cloud' ? 'cloud' : 'self-hosted', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: new Date().toISOString() });
    if (p.endsWith('/users/me')) return json(ADMIN);
    if (p.endsWith('/license/edition')) return json(opts.edition ?? COMMUNITY);
    if (p.endsWith('/license/status')) {
      if (opts.status) return json(opts.status);
      return json(
        opts.mode === 'cloud'
          ? { plan: 'cloud_team', status: 'active', expiresAt: null, features: {} }
          : { plan: null, status: 'none', features: {} },
      );
    }
    if (p.endsWith('/license/usage') && opts.usage) return json(opts.usage);
    if (p.endsWith('/users') && opts.users) return json(opts.users);
    if (p.endsWith('/users/invitations') || p.endsWith('/roles')) return json([]);
    if (p.endsWith('/identity-providers') || p.endsWith('/connectors') || p.endsWith('/adapters')) return json([]);
    return json({});
  });
}

test.describe('Enterprise instead of Business (self-hosted)', () => {
  test('the edition card offers the Enterprise trial and an Enterprise enquiry', async ({ page }) => {
    await session(page, { mode: 'self-hosted' });
    await page.goto('/settings/license');
    await expect(page.getByRole('button', { name: 'Try Enterprise free for 30 days' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('With Enterprise')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Contact us about Enterprise' })).toHaveAttribute(
      'href',
      /\/contact\?plan=enterprise$/,
    );
    await expect(page.getByText(/Business/)).toHaveCount(0);
  });

  test('a running trial is shown as an Enterprise trial', async ({ page }) => {
    await session(page, {
      mode: 'self-hosted',
      edition: {
        ...COMMUNITY,
        edition: 'business',
        business: true,
        source: 'trial',
        seatLimit: null,
        trialAvailable: false,
        trialEndsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
    });
    await page.goto('/settings/license');
    await expect(page.getByRole('heading', { name: 'Enterprise', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^Enterprise trial: \d+ days? left\.$/)).toBeVisible();
    await expect(page.getByText(/Business/)).toHaveCount(0);
  });

  test('single sign-on setup points to Enterprise', async ({ page }) => {
    await session(page, { mode: 'self-hosted' });
    await page.goto('/settings/identity-providers');
    await expect(page.getByText('Single sign-on and SCIM are part of AnythingMCP Enterprise')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Contact us about Enterprise' })).toHaveAttribute(
      'href',
      /\/contact\?plan=enterprise$/,
    );
    await expect(page.getByText(/Business/)).toHaveCount(0);
  });
});

/**
 * Self-hosted is sold as Community (free for any use, commercial included) and
 * Enterprise (on request) since 3 Nov 2026. Starter and Team are no longer
 * offered there, but an instance that holds such a key still shows its plan.
 */
test.describe('Self-hosted: Community and Enterprise only', () => {
  test('the license page offers no self-hosted plan to buy', async ({ page }) => {
    await session(page, { mode: 'self-hosted' });
    await page.goto('/settings/license');
    await expect(page.getByText(/Community is free for any use, including commercial use, for up to 3 active users\./)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Enter the license key you received from us. Existing Starter and Team keys keep working.')).toBeVisible();
    await expect(page.getByText('File Search after the 30-day trial')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try Enterprise free for 30 days' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Contact us about Enterprise' })).toHaveAttribute('href', /\/contact\?plan=enterprise$/);
    await expect(page.getByRole('link', { name: 'View plans' })).toHaveCount(0);
    await expect(page.locator('a[href*="/pricing"]')).toHaveCount(0);
    // The free Community registration and the key field stay.
    await expect(page.getByRole('button', { name: 'Register Free Community License' })).toBeVisible();
    await expect(page.getByPlaceholder('AMCP-XXXX-XXXX-XXXX-XXXX')).toBeVisible();
  });

  test('an instance with a Team key still shows its plan', async ({ page }) => {
    await session(page, {
      mode: 'self-hosted',
      edition: { ...COMMUNITY, edition: 'team', source: 'license', plan: 'team', seatLimit: 10, trialAvailable: false },
      status: { plan: 'team', status: 'active', expiresAt: null, lastVerifiedAt: null, instanceId: 'i1', features: {} },
    });
    await page.goto('/settings/license');
    await expect(page.getByText('License (team)')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();
    await expect(page.locator('div.font-medium').filter({ hasText: /^Team$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change License Key' })).toBeVisible();
    await expect(page.locator('a[href*="/pricing"]')).toHaveCount(0);
  });

  test('a full Community instance is pointed to Enterprise, not to a plan', async ({ page }) => {
    await session(page, {
      mode: 'self-hosted',
      edition: { ...COMMUNITY, seatsUsed: 3 },
      users: [1, 2, 3].map((n) => ({
        id: `u${n}`,
        email: `user${n}@example.test`,
        name: `User ${n}`,
        role: n === 1 ? 'ADMIN' : 'EDITOR',
        isActive: true,
        createdAt: new Date().toISOString(),
      })),
    });
    await page.goto('/settings/users');
    await expect(page.getByText('Community includes 3 users')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Contact us about Enterprise' })).toHaveAttribute('href', /\/contact\?plan=enterprise$/);
    await expect(page.getByRole('link', { name: 'View plans' })).toHaveCount(0);
  });
});

test.describe('Enterprise instead of Business (cloud)', () => {
  test('a Team workspace over its limits is pointed to an Enterprise enquiry, not a checkout', async ({ page }) => {
    await session(page, {
      mode: 'cloud',
      usage: {
        plan: 'team',
        connectors: { current: 16, max: 15, isOver: true },
        mcpServers: { current: 2, max: 10, isOver: false },
        users: { current: 2, max: 3, isOver: false },
        isOverAny: true,
      },
    });
    await page.goto('/connectors');
    await expect(page.getByText(/upgrade to/)).toContainText('Enterprise', { timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Contact us' })).toHaveAttribute(
      'href',
      /\/contact\?plan=enterprise&utm_source=soft-warn/,
    );
    await expect(page.getByRole('link', { name: 'Change plan' })).toHaveCount(0);
  });
});
