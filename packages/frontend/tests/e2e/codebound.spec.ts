import { expect, test, type Page } from '@playwright/test';

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function openEditor(
  page: Page,
  fail = false,
  options: { viewer?: boolean; conflict?: boolean } = {},
) {
  const runs: unknown[] = [];
  let saved: Record<string, any> | null = options.viewer
    ? {
        id: 'script-1',
        name: 'Shared post',
        description: 'A shared script',
        mcpServerId: 's1',
        code: 'return await tools.call("setup_demo_get_post", {});',
        input: {},
        allowedTools: ['setup_demo_get_post'],
        revision: 1,
        createdAt: '2026-10-17T00:00:00Z',
        updatedAt: '2026-10-17T00:00:00Z',
      }
    : null;
  const user = { ...USER, role: options.viewer ? 'VIEWER' : 'ADMIN' };
  await page
    .context()
    .addCookies([
      { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
    ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, user);
  await page.route('**/health/server-info', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ deploymentMode: 'self-hosted' }),
    }),
  );
  await page.route(/\/api\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    const pathname = new URL(url).pathname;
    const method = route.request().method();
    if (pathname === '/api/codebound/scripts' && method === 'GET')
      return json({ items: saved ? [saved] : [], total: saved ? 1 : 0 });
    if (pathname === '/api/codebound/scripts' && method === 'POST') {
      saved = {
        ...route.request().postDataJSON(),
        id: 'script-1',
        revision: 1,
        createdAt: '2026-10-17T00:00:00Z',
        updatedAt: '2026-10-17T00:00:00Z',
      };
      return json(saved);
    }
    if (pathname === '/api/codebound/scripts/script-1/run') {
      runs.push(route.request().postDataJSON());
      return json({
        runId: 'saved-run',
        result: { id: 1, title: 'Demo post' },
        calls: 1,
        durationMs: 45,
      });
    }
    if (pathname === '/api/codebound/scripts/script-1' && method === 'PUT') {
      if (options.conflict)
        return json(
          { message: 'Script changed. Reopen it before saving.' },
          409,
        );
      saved = {
        ...saved,
        ...route.request().postDataJSON(),
        revision: Number(saved?.revision) + 1,
      };
      return json(saved);
    }
    if (pathname === '/api/codebound/scripts/script-1' && method === 'DELETE') {
      saved = null;
      return json({ deleted: true });
    }
    if (pathname === '/api/codebound/scripts/script-1')
      return saved ? json(saved) : json({ message: 'Script not found.' }, 404);
    if (url.includes('/api/codebound/servers/s1/tools'))
      return json([
        {
          name: 'setup_demo_get_post',
          description: 'Read a post',
          inputSchema: { type: 'object' },
          outputSchema: null,
        },
      ]);
    if (url.includes('/api/codebound/servers/s1/run')) {
      runs.push(route.request().postDataJSON());
      return fail
        ? json({ message: 'Script exceeded the 5 second time limit.' }, 400)
        : json({
            runId: 'run-1',
            result: { id: 1, title: 'Demo post' },
            calls: 1,
            durationMs: 45,
          });
    }
    if (url.includes('/api/mcp-servers'))
      return json([{ id: 's1', name: 'Demo server', isActive: true }]);
    if (url.includes('/api/users/me/onboarding-state'))
      return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(user);
    if (url.includes('/api/organizations/current'))
      return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine'))
      return json([
        { id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' },
      ]);
    if (url.includes('/api/license/status'))
      return json({ plan: 'community', status: 'active' });
    return json({});
  });
  await page.goto('/codebound');
  await expect(
    page.getByRole('checkbox', { name: 'setup_demo_get_post' }),
  ).toBeChecked();
  return runs;
}

test('runs the starter script and shows the compact result', async ({
  page,
}) => {
  const runs = await openEditor(page);
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1 tool calls');
  await expect(page.getByLabel('Script result')).toContainText('Demo post');
  expect(runs).toEqual([
    expect.objectContaining({
      input: {},
      allowedTools: ['setup_demo_get_post'],
    }),
  ]);
  await page.getByRole('checkbox', { name: 'setup_demo_get_post' }).uncheck();
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect.poll(() => runs.length).toBe(2);
  expect(runs[1]).toEqual(expect.objectContaining({ allowedTools: [] }));
});

test('saves, reloads, opens, runs, edits, and deletes a reusable script', async ({
  page,
}) => {
  const runs = await openEditor(page);
  await page.getByLabel('Script name', { exact: true }).fill('Post summary');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Keep only the post identifier and title');
  await page.getByLabel('Parameters (JSON)').fill('{"postId":1}');
  await page.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Script notification' }),
  ).toHaveText('Script saved.');
  await expect(
    page.getByRole('button', { name: 'Open Post summary', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'Open Post summary', exact: true })
    .click();
  await expect(page.getByLabel('Script name', { exact: true })).toHaveValue(
    'Post summary',
  );
  await expect(page.getByLabel('Parameters (JSON)')).toHaveValue(/"postId": 1/);
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(page.getByLabel('Script result')).toContainText('Demo post');
  expect(runs).toEqual([{ input: { postId: 1 }, revision: 1 }]);
  await page
    .getByLabel('JavaScript', { exact: true })
    .fill('return { ready: true };');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Script notification' }),
  ).toHaveText('Script saved.');
  await page
    .getByRole('button', { name: 'Open Post summary', exact: true })
    .click();
  await expect(page.getByLabel('JavaScript', { exact: true })).toHaveValue(
    'return { ready: true };',
  );
  await page
    .getByRole('button', { name: 'Delete Post summary', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm delete', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Open Post summary', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Script name', { exact: true })).toHaveValue('');
});

test('preserves unsaved source after a concurrent update is rejected', async ({
  page,
}) => {
  await openEditor(page, false, { conflict: true });
  await page
    .getByLabel('Script name', { exact: true })
    .fill('Concurrent script');
  await page.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Script notification' }),
  ).toHaveText('Script saved.');
  await page
    .getByLabel('JavaScript', { exact: true })
    .fill('return "my unsaved change";');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Script error' })).toContainText(
    'Script changed',
  );
  await expect(page.getByLabel('JavaScript', { exact: true })).toHaveValue(
    'return "my unsaved change";',
  );
});

test('lets a viewer open and run without save or delete controls', async ({
  page,
}) => {
  const runs = await openEditor(page, false, { viewer: true });
  await page
    .getByRole('button', { name: 'Open Shared post', exact: true })
    .click();
  await expect(page.getByLabel('Script name', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', {
      name: /Save script|Save changes|Delete Shared post/,
    }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(page.getByLabel('Script result')).toContainText('Demo post');
  expect(runs).toEqual([{ input: {}, revision: 1 }]);
});

test('returns to an available page when another editor removes the last page', async ({ page }) => {
  await openEditor(page);
  let removed = false;
  const items = Array.from({ length: 21 }, (_, index) => ({
    id: `paged-${index + 1}`, name: `Saved script ${index + 1}`, description: '',
    mcpServerId: 's1', revision: 1, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
  }));
  await page.route('**/api/codebound/scripts?**', async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    const current = removed ? items.slice(0, 1) : items;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: current.slice(offset, offset + 20), total: current.length }) });
  });
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Saved script 20', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Saved script 21', exact: true })).toBeVisible();
  removed = true;
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Saved script 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
});

test('shows a clear execution error and enables another run', async ({
  page,
}) => {
  await openEditor(page, true);
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Script error' })).toHaveText(
    'Script exceeded the 5 second time limit.',
  );
  await expect(
    page.getByRole('button', { name: 'Run script', exact: true }),
  ).toBeEnabled();
});

test('rejects invalid JSON parameters before sending the run', async ({
  page,
}) => {
  const runs = await openEditor(page);
  await page.getByLabel('Parameters (JSON)').fill('[]');
  await page.getByRole('button', { name: 'Run script', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Script error' })).toHaveText(
    'Parameters must be a JSON object.',
  );
  expect(runs).toHaveLength(0);
});
