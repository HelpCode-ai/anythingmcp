import { expect, test, type Page } from '@playwright/test';

/**
 * Learning projects: an admin starts one for a member on an MCP server, the
 * member accepts it in their profile, an editor confirms a lesson and
 * publishes the topic. A plan without learning projects shows what they are
 * and no way to start one. The API is mocked, as in the other smoke tests.
 */

const BASE_URL = 'http://localhost:3100';

type Role = 'ADMIN' | 'EDITOR' | 'VIEWER';

interface Setup {
  role: Role;
  cloud?: boolean;
  allowance?: { max: number | null; full: boolean; plan: string; used: number };
  projects?: any[];
  mine?: any[];
}

const PROJECT = {
  id: 'p1',
  name: 'Old window hardware',
  status: 'active',
  overPlan: false,
  publishMode: 'manual',
  tags: ['windows'],
  showExpertName: false,
  expert: { id: 'u2', name: 'Pat', email: 'pat@example.test' },
  mcpServer: { id: 's1', name: 'Sales server' },
  folder: null,
  startsAt: '2026-11-15T10:00:00Z',
  endsAt: null,
  consentAt: '2026-11-15T10:00:00Z',
  createdAt: '2026-11-15T09:00:00Z',
  topics: 1,
  lessons: { draft: 1, confirmed: 1, rejected: 0 },
};

const TOPIC = {
  id: 't1',
  title: 'Old windows',
  whenToUse: 'Quotes for old windows',
  draftSkillId: 'sk-d',
  publishedSkillId: null,
  publishedAt: null,
  lessons: { draft: 1, confirmed: 1, rejected: 0 },
  unpublished: true,
};

const LESSON = {
  id: 'l1',
  projectId: 'p1',
  topicId: 't1',
  kind: 'correction',
  text: 'Take hinge BR-12103 for series 300',
  detail: { before: 'hinge BR-99', after: 'hinge BR-12103', reason: 'BR-99 is discontinued' },
  status: 'draft',
  source: 'model',
  seenCount: 1,
  confirmedAt: null,
  createdAt: '2026-11-15T11:00:00Z',
  topic: { title: 'Old windows' },
};

async function fakeSession(page: Page, setup: Setup) {
  const user = { id: 'u1', email: 'admin@example.test', name: 'Admin', role: setup.role, organizationId: 'o1', emailVerified: true };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const state = { projects: [...(setup.projects ?? [])], mine: [...(setup.mine ?? [])] };
  await page.context().addCookies([{ name: 'amcp_token', value: 't', url: BASE_URL }]);
  await page.addInitScript((u) => {
    localStorage.setItem('amcp_token', 't');
    localStorage.setItem('amcp_user', JSON.stringify(u));
  }, user);
  await page.route(/\/(api|health)\//, async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (method !== 'GET') calls.push({ method, path: p, body: request.postDataJSON?.() ?? null });

    if (p === '/health/server-info') {
      return json({ deploymentMode: setup.cloud ? 'cloud' : 'self-hosted', mcpAuthMode: 'oauth2', hasUsers: true, ssoProviders: [] });
    }
    if (p === '/api/learning/projects' && method === 'GET') {
      return json({
        allowance: setup.allowance ?? { max: 1, full: false, plan: 'team', used: state.projects.length },
        projects: state.projects,
      });
    }
    if (p === '/api/learning/projects' && method === 'POST') {
      const body = request.postDataJSON();
      state.projects.push({ ...PROJECT, id: 'p-new', name: body.name, status: 'draft', consentAt: null, topics: 0, lessons: { draft: 0, confirmed: 0, rejected: 0 } });
      return json({ id: 'p-new' });
    }
    if (p === '/api/learning/projects/p1' && method === 'GET') return json({ ...PROJECT, topics: [TOPIC] });
    if (p === '/api/learning/projects/p1/lessons') return json({ items: [LESSON], total: 1, take: 50, skip: 0 });
    if (p === '/api/learning/lessons/l1') return json({ ...LESSON, status: 'confirmed' });
    if (p === '/api/learning/topics/t1/preview') {
      return json({ topic: { id: 't1', title: 'Old windows' }, instruction: 'x', body: '## Rules\n- Check the groove width first', included: 1, dropped: 0 });
    }
    if (p === '/api/learning/topics/t1/publish') return json({ skillId: 'sk-p', lessons: 1, dropped: 0 });
    if (p === '/api/learning/me') return json(state.mine);
    if (/^\/api\/learning\/projects\/[^/]+\/(consent|withdraw)$/.test(p)) {
      state.mine = [];
      return json({ ok: true, erased: 0 });
    }
    if (p === '/api/users') {
      return json([
        { id: 'u1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' },
        { id: 'u2', email: 'pat@example.test', name: 'Pat', role: 'EDITOR' },
      ]);
    }
    if (p === '/api/mcp-servers') return json([{ id: 's1', name: 'Sales server' }]);
    if (p === '/api/knowledge-folders') return json({ folders: [], restrictionsAvailable: false });
    if (p === '/api/users/me/onboarding-state') return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (p === '/api/users/me') return json(user);
    if (p === '/api/organizations/current') return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (p === '/api/organizations/mine') return json([{ id: 'o1', name: 'Acme', role: setup.role, joinedAt: '2026-01-01' }]);
    if (p === '/api/license/status') return json({ plan: 'team', status: 'active' });
    if (p === '/api/settings/member-visibility') return json({ mode: 'open', restrictedForMe: false });
    if (p === '/api/knowledge-graph/learning/me') return json({ workspaceDefault: false, mode: 'inherit', optOut: false, effective: false });
    return json({});
  });
  return { calls };
}

test('an admin starts a learning project for a member on a server', async ({ page }) => {
  const { calls } = await fakeSession(page, { role: 'ADMIN', allowance: { max: 1, full: false, plan: 'team', used: 0 } });
  await page.goto('/knowledge-graph/learning');

  await expect(page.getByTestId('learning-allowance')).toHaveText('0 of 1 learning projects in use.');
  await page.getByRole('button', { name: 'New learning project' }).click();
  const form = page.getByTestId('learning-new-form');
  const start = form.getByRole('button', { name: 'Start and ask the member' });
  await expect(start).toBeDisabled();

  await form.getByRole('textbox', { name: 'Name' }).fill('Old window hardware');
  await form.getByRole('combobox', { name: 'Learn from' }).click();
  await page.getByRole('option', { name: 'Pat (pat@example.test)' }).click();
  await form.getByRole('combobox', { name: 'On the MCP server' }).click();
  await page.getByRole('option', { name: 'Sales server' }).click();
  await form.getByLabel('Labels (optional)').fill('windows, hardware');
  await start.click();

  await expect(page.getByText('Started. The member accepts it under Settings → Profile')).toBeVisible();
  const created = calls.find((c) => c.method === 'POST' && c.path === '/api/learning/projects');
  expect(created?.body).toEqual(
    expect.objectContaining({
      name: 'Old window hardware',
      userId: 'u2',
      mcpServerId: 's1',
      tags: ['windows', 'hardware'],
      publishMode: 'manual',
      showExpertName: false,
    }),
  );
  const card = page.getByTestId('learning-project');
  await expect(card).toContainText('Old window hardware');
  await expect(card).toContainText('Waiting for the member');
});

test('a plan without learning projects says what they are and offers no way to start one', async ({ page }) => {
  await fakeSession(page, { role: 'ADMIN', cloud: true, allowance: { max: 0, full: false, plan: 'starter', used: 0 } });
  await page.goto('/knowledge-graph/learning');

  const upsell = page.getByTestId('learning-upsell');
  await expect(upsell).toContainText('Learning projects are part of the Team and Enterprise plans');
  await expect(upsell.getByRole('link', { name: 'See plans' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New learning project' })).toHaveCount(0);
});

test('a full plan explains why no project can be started', async ({ page }) => {
  await fakeSession(page, { role: 'ADMIN', projects: [PROJECT], allowance: { max: 1, full: false, plan: 'team', used: 1 } });
  await page.goto('/knowledge-graph/learning');
  await expect(page.getByRole('button', { name: 'New learning project' })).toBeDisabled();
  await expect(page.getByText("Your plan's learning projects are all in use.")).toBeVisible();
  await expect(page.getByTestId('learning-project')).toContainText('Learning from Pat');
});

test('an editor confirms a lesson, previews the topic and publishes it, without project controls', async ({ page }) => {
  const { calls } = await fakeSession(page, { role: 'EDITOR', projects: [PROJECT] });
  await page.goto('/knowledge-graph/learning/p1');

  await expect(page.getByTestId('learning-status')).toHaveText('Active');
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);

  const topic = page.getByTestId('learning-topic');
  await expect(topic).toContainText('Confirmed changes to publish');
  await topic.getByRole('button', { name: 'Preview' }).click();
  await expect(topic).toContainText('Check the groove width first');
  await topic.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published: 1 lesson(s) are now a skill for everyone on this server.')).toBeVisible();
  expect(calls.some((c) => c.method === 'POST' && c.path === '/api/learning/topics/t1/publish')).toBe(true);

  await page.getByRole('button', { name: /^Lessons/ }).click();
  const lesson = page.getByTestId('learning-lesson');
  await expect(lesson).toContainText('Take hinge BR-12103 for series 300');
  await expect(lesson).toContainText('Instead of: hinge BR-99');
  await expect(lesson).toContainText('Why: BR-99 is discontinued');
  await lesson.getByRole('button', { name: 'Confirm' }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'PATCH' && c.path === '/api/learning/lessons/l1')?.body)
    .toEqual({ status: 'confirmed' });
});

test('the member reads what is kept and accepts in their profile; the notice they saw is what is sent', async ({ page }) => {
  const mine = [{ id: 'p1', name: 'Old window hardware', status: 'draft', mcpServer: { id: 's1', name: 'Sales server' }, consentAt: null, endsAt: null, showExpertName: false }];
  const { calls } = await fakeSession(page, { role: 'EDITOR', mine });
  await page.goto('/settings');

  const consent = page.getByTestId('learning-consent');
  await expect(consent).toContainText('Your admin asks to keep what you teach the AI on the MCP server “Sales server”');
  await expect(consent).toContainText('Not kept: the conversation itself');
  await expect(consent).toContainText('Your name is shown to admins only.');
  await consent.getByRole('button', { name: 'Accept' }).click();

  await expect(page.getByText('Accepted. Refresh the tools list of this connector')).toBeVisible();
  const sent = calls.find((c) => c.path === '/api/learning/projects/p1/consent')?.body;
  expect(sent.notice).toContain('On the MCP server “Sales server”');
  expect(sent.notice).toContain('You can stop at any time');
  expect(sent.notice).toContain('Your name is shown to admins only.');
});

test('the member stops a project and can erase what was not published', async ({ page }) => {
  const mine = [{ id: 'p1', name: 'Old window hardware', status: 'active', mcpServer: { id: 's1', name: 'Sales server' }, consentAt: '2026-11-15T10:00:00Z', endsAt: null, showExpertName: false }];
  const { calls } = await fakeSession(page, { role: 'EDITOR', mine });
  await page.goto('/settings');

  const card = page.getByTestId('learning-projects-card');
  await expect(card).toContainText('“Old window hardware” is active on “Sales server”');
  await card.getByLabel('Also erase my lessons that were not published').check();
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toContainText('Stopped.');
  expect(calls.find((c) => c.path === '/api/learning/projects/p1/withdraw')?.body).toEqual({ erase: true });
});

test('a member without a learning project sees no card', async ({ page }) => {
  await fakeSession(page, { role: 'EDITOR', mine: [] });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
  await expect(page.getByTestId('learning-projects-card')).toHaveCount(0);
});
