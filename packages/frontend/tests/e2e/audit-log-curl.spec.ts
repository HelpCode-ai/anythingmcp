import { expect, test, type Page } from '@playwright/test';
import { buildToolCallCurl, redactSensitiveArgs } from '../../src/lib/curl';

const USER = {
  id: 'u1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

async function fakeSession(page: Page, authMode = 'both') {
  await page.context().addCookies([
    { name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' },
  ]);
  await page.addInitScript((user) => {
    localStorage.setItem('amcp_token', 'test-token');
    localStorage.setItem('amcp_user', JSON.stringify(user));
  }, USER);

  await page.route(/\/(api|health)\//, async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/health/server-info')) {
      return json({
        deploymentMode: 'self-hosted',
        mcpAuthMode: authMode,
        serverUrl: 'http://localhost:4000',
        mcpEndpoint: 'http://localhost:4000/mcp',
        hasUsers: true,
        registrationEnabled: true,
        ssoProviders: [],
      });
    }
    if (url.includes('/api/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    if (url.includes('/api/users/me')) return json(USER);
    if (url.includes('/api/organizations/current')) return json({ id: 'o1', name: 'Acme', createdAt: '2026-01-01' });
    if (url.includes('/api/organizations/mine')) return json([{ id: 'o1', name: 'Acme', role: 'ADMIN', joinedAt: '2026-01-01' }]);
    if (url.includes('/api/license/status')) return json({ plan: 'community', status: 'active' });
    if (url.includes('/api/connectors')) return json([]);
    if (url.includes('/api/mcp-servers')) return json([{ id: 'srv-1', name: 'Test Server', slug: 'test-server' }]);
    if (url.includes('/api/audit/stats')) return json({ invocations24h: 3, errors24h: 0 });
    if (url.includes('/api/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 3, successRate: 100, avgDuration: 10 });
    if (url.includes('/api/audit/invocations')) {
      return json([
        {
          id: 'log-1',
          createdAt: new Date().toISOString(),
          status: 'SUCCESS',
          durationMs: 42,
          mcpServerId: 'srv-1',
          mcpServer: { id: 'srv-1', name: 'Test Server', slug: 'test-server' },
          toolId: 't-1',
          tool: { name: 'echo_message', connector: { name: 'Echo Service', type: 'REST' } },
          input: { message: 'hello world', target: 'cli' },
          output: { result: 'ok' },
          clientInfo: JSON.stringify({ authMethod: 'mcp_api_key', apiKeyName: 'test-key' }),
        },
        {
          id: 'log-2',
          createdAt: new Date().toISOString(),
          status: 'SUCCESS',
          durationMs: 30,
          mcpServerId: null,
          mcpServer: null,
          toolId: 't-2',
          tool: { name: 'shared_calc', connector: { name: 'Calc', type: 'REST' } },
          input: { expr: '2+2' },
          output: { result: 4 },
          clientInfo: null,
        },
        {
          id: 'log-3',
          createdAt: new Date().toISOString(),
          status: 'SUCCESS',
          durationMs: 15,
          mcpServerId: 'srv-1',
          mcpServer: { id: 'srv-1', name: 'Test Server', slug: 'test-server' },
          toolId: 't-3',
          tool: { name: 'large_fetch', connector: { name: 'Data', type: 'REST' } },
          input: { _amcp_truncated: true, items: ['cut...'] },
          output: { count: 100 },
          clientInfo: null,
        },
      ]);
    }
    return json({});
  });
}

test.describe('buildToolCallCurl builder unit tests', () => {
  test('generates expected cURL command for legacy/both auth mode', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-123',
      toolName: 'my_tool',
      args: { query: 'test', limit: 10 },
      authMode: 'both',
    });

    expect(cmd).toContain("curl -sS -X POST 'http://localhost:4000/mcp/srv-123' \\");
    expect(cmd).toContain('-H "Content-Type: application/json" \\');
    expect(cmd).toContain('-H "Accept: application/json, text/event-stream" \\');
    expect(cmd).toContain('-H "MCP-Protocol-Version: 2025-06-18" \\');
    expect(cmd).toContain('-H "X-API-Key: $AMCP_MCP_API_KEY" \\');
    expect(cmd).toContain("--data-binary @- <<'JSON'");
    expect(cmd).toContain('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_tool","arguments":{"query":"test","limit":10}}}');
    expect(cmd.endsWith('JSON')).toBe(true);
  });

  test('generates Authorization: Bearer placeholder for oauth2 auth mode', () => {
    const cmd = buildToolCallCurl({
      origin: 'https://cloud.anythingmcp.com',
      serverId: 'srv-abc',
      toolName: 'fetch_user',
      args: { id: 'u123' },
      authMode: 'oauth2',
    });

    expect(cmd).toContain("curl -sS -X POST 'https://cloud.anythingmcp.com/mcp/srv-abc' \\");
    expect(cmd).toContain('-H "Authorization: Bearer $AMCP_ACCESS_TOKEN" \\');
    expect(cmd).not.toContain('$AMCP_MCP_API_KEY');
    expect(cmd).not.toContain('test-token');
  });

  test('normalizes trailing slashes on origin', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000///',
      serverId: 'srv-1',
      toolName: 'ping',
      args: {},
    });

    expect(cmd).toContain("'http://localhost:4000/mcp/srv-1'");
  });

  test('preserves single quotes, double quotes, dollar signs, backticks, and newlines in args', () => {
    const trickyArgs = {
      message: "it's a test with \"quotes\", $VAR, `cmd`, and \n newline",
      unicode: '🚀 日本語 test',
    };
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'tricky_tool',
      args: trickyArgs,
    });

    expect(cmd).toContain("--data-binary @- <<'JSON'");
    const jsonLine = cmd.split('\n').find((l) => l.startsWith('{"jsonrpc"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.params.arguments).toEqual(trickyArgs);
  });

  test('redacts sensitive keys in arguments', () => {
    const sensitiveArgs = {
      user: 'alice',
      password: 'super-secret-password',
      apiKey: 'real_api_key_123',
      nested: {
        accessToken: 'bearer_token_xyz',
        auth: { client_secret: 'secret999' },
        safe: 'normal_val',
      },
    };

    const redacted = redactSensitiveArgs(sensitiveArgs) as any;
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.nested.accessToken).toBe('[REDACTED]');
    expect(redacted.nested.auth.client_secret).toBe('[REDACTED]');
    expect(redacted.nested.safe).toBe('normal_val');
    expect(redacted.user).toBe('alice');

    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'auth_tool',
      args: sensitiveArgs,
    });
    expect(cmd).not.toContain('super-secret-password');
    expect(cmd).not.toContain('real_api_key_123');
    expect(cmd).not.toContain('bearer_token_xyz');
    expect(cmd).not.toContain('secret999');
    expect(cmd).toContain('[REDACTED]');
    expect(cmd.split('\n')[0]).toMatch(/^# Some arguments were replaced with \[REDACTED\]/);
  });

  test('adds no note when nothing was redacted', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'plain',
      args: { q: 'x' },
    });
    expect(cmd.startsWith('curl ')).toBe(true);
  });

  test('a value cannot end the heredoc early', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'breakout',
      args: { note: "x\nJSON\nrm -rf ~\n", other: 'JSON' },
    });
    const lines = cmd.split('\n');
    // The only bare JSON line is the closing delimiter, and nothing follows it.
    expect(lines.filter((l) => l === 'JSON')).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe('JSON');
    expect(lines.some((l) => l.startsWith('rm '))).toBe(false);
  });

  test('keeps shell characters in the server id out of the shell', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: "a'$(id)`x`",
      toolName: 't',
      args: {},
    });
    const urlLine = cmd.split('\n').find((l) => l.startsWith('curl '))!;
    expect(urlLine).toBe("curl -sS -X POST 'http://localhost:4000/mcp/a%27%24(id)%60x%60' \\");
  });

  test('replaces values nested deeper than the walk instead of passing them through', () => {
    let deep: Record<string, unknown> = { password: 'deep-secret' };
    for (let i = 0; i < 15; i++) deep = { level: deep };
    expect(JSON.stringify(redactSensitiveArgs(deep))).not.toContain('deep-secret');
  });

  test('handles null, undefined, string, or empty args safely', () => {
    const cmd1 = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'empty_tool',
      args: null,
    });
    expect(cmd1).toContain('"arguments":{}');

    const cmd2 = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'json_string_tool',
      args: '{"foo":"bar"}',
    });
    expect(cmd2).toContain('"arguments":{"foo":"bar"}');
  });
});

test.describe('Audit log "Copy as cURL" UI interaction', () => {
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('copies valid tool call command and shows proper disabled states for shared and truncated rows', async ({
    page,
    context,
  }) => {
    await fakeSession(page, 'both');
    await page.goto('/logs');

    // Wait for log rows to render
    await expect(page.getByTitle('echo_message')).toBeVisible();
    await expect(page.getByTitle('shared_calc')).toBeVisible();
    await expect(page.getByTitle('large_fetch')).toBeVisible();

    // 1. Expand the first row (valid per-server log)
    await page.getByTitle('echo_message').click();

    // Verify Copy as cURL button is visible and enabled
    const copyBtn = page.getByRole('button', { name: 'Copy as cURL' });
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toBeEnabled();

    // Click Copy as cURL
    await copyBtn.click();

    // Verify feedback
    await expect(page.getByText('Copied!')).toBeVisible();

    // Read clipboard text and verify structure
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedText).toContain('curl -sS -X POST');
    expect(copiedText).toContain('/mcp/srv-1');
    expect(copiedText).toContain('-H "MCP-Protocol-Version: 2025-06-18"');
    expect(copiedText).toContain('-H "X-API-Key: $AMCP_MCP_API_KEY"');
    expect(copiedText).toContain("--data-binary @- <<'JSON'");
    expect(copiedText).toContain('"method":"tools/call"');
    expect(copiedText).toContain('"name":"echo_message"');
    expect(copiedText).toContain('"message":"hello world"');

    // 2. Expand second row (shared endpoint)
    await page.getByTitle('shared_calc').click();
    const sharedRowDisabled = page.locator('span[title="Replay unavailable: call ran through the shared /mcp endpoint"]');
    await expect(sharedRowDisabled).toBeVisible();
    const sharedBtn = sharedRowDisabled.getByRole('button', { name: 'Copy as cURL' });
    await expect(sharedBtn).toBeDisabled();

    // 3. Expand third row (truncated input)
    await page.getByTitle('large_fetch').click();
    const truncatedRowDisabled = page.locator('span[title="Replay unavailable: stored input parameters were truncated"]');
    await expect(truncatedRowDisabled).toBeVisible();
    const truncatedBtn = truncatedRowDisabled.getByRole('button', { name: 'Copy as cURL' });
    await expect(truncatedBtn).toBeDisabled();
  });
});
