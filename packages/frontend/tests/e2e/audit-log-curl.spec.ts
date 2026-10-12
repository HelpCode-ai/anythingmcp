import { expect, test, type Page } from '@playwright/test';
import {
  buildToolCallCurl,
  redactSensitiveArgs,
  REDACTED_PLACEHOLDER,
  TRUNCATED_DEPTH_PLACEHOLDER,
} from '../../src/lib/curl';

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
    if (url.includes('/api/audit/stats')) return json({ invocations24h: 4, errors24h: 0 });
    if (url.includes('/api/audit/analytics')) return json({ daily: [], topTools: [], totalInvocations: 4, successRate: 100, avgDuration: 10 });
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
        {
          id: 'log-4',
          createdAt: new Date().toISOString(),
          status: 'SUCCESS',
          durationMs: 12,
          mcpServerId: 'srv-1',
          mcpServer: { id: 'srv-1', name: 'Test Server', slug: 'test-server' },
          toolId: 't-missing-name',
          tool: null,
          input: { test: 'val' },
          output: { ok: true },
          clientInfo: null,
        },
      ]);
    }
    return json({});
  });
}

test.describe('buildToolCallCurl builder unit tests', () => {
  test('generates expected cURL command with single-quoted URL and placeholders for legacy/both auth mode', () => {
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

  test('supports authMethod parameter from clientInfo (jwt, static_bearer, mcp_api_key, none)', () => {
    const cmdJwt = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'tool1',
      args: {},
      authMode: 'both',
      authMethod: 'jwt',
    });
    expect(cmdJwt).toContain('-H "Authorization: Bearer $AMCP_ACCESS_TOKEN" \\');
    expect(cmdJwt).not.toContain('$AMCP_MCP_API_KEY');

    const cmdStaticBearer = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'tool1',
      args: {},
      authMode: 'both',
      authMethod: 'static_bearer',
    });
    expect(cmdStaticBearer).toContain('-H "Authorization: Bearer $AMCP_ACCESS_TOKEN" \\');

    const cmdApiKey = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'tool1',
      args: {},
      authMode: 'oauth2',
      authMethod: 'mcp_api_key',
    });
    expect(cmdApiKey).toContain('-H "X-API-Key: $AMCP_MCP_API_KEY" \\');

    const cmdNone = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'tool1',
      args: {},
      authMode: 'both',
      authMethod: 'none',
    });
    expect(cmdNone).not.toContain('$AMCP_MCP_API_KEY');
    expect(cmdNone).not.toContain('$AMCP_ACCESS_TOKEN');
  });

  test('encodes serverId with encodeURIComponent and quotes URL with single quotes for shell safety', () => {
    const trickyServerId = "srv$123 `rm -rf` 'quoted' space/slash";
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: trickyServerId,
      toolName: 'ping',
      args: {},
    });

    // Should encode the special characters into percent-encoding
    const expectedEncoded = encodeURIComponent(trickyServerId).replace(/'/g, "'\\''");
    expect(cmd).toContain(`'http://localhost:4000/mcp/${expectedEncoded}'`);
    expect(cmd).not.toContain('$123');
    expect(cmd).not.toContain('`rm -rf`');
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

  test('handles heredoc collision when payload contains delimiter lines', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'breakout_tool',
      args: { test: 'line1\nJSON\nline2' },
    });

    // When payload contains \nJSON, the delimiter switches away from JSON to avoid collision
    expect(cmd).toContain("<<'EOF_AMCP_JSON'");
    expect(cmd.endsWith('EOF_AMCP_JSON')).toBe(true);
  });

  test('emits warning comments when sensitive arguments are redacted', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'secret_tool',
      args: { password: 'my-password' },
    });

    expect(cmd).toContain('# WARNING: Sensitive arguments were redacted ([REDACTED]).');
    expect(cmd).toContain('# Replace placeholder values with valid credentials before replaying.');
    expect(cmd).toContain('[REDACTED]');
    expect(cmd).not.toContain('my-password');
  });

  test('emits warning comment and strips truncation marker when args contain _amcp_truncated', () => {
    const cmd = buildToolCallCurl({
      origin: 'http://localhost:4000',
      serverId: 'srv-1',
      toolName: 'cut_tool',
      args: { _amcp_truncated: true, validKey: 'value' },
    });

    expect(cmd).toContain('# WARNING: Stored input arguments were truncated in the audit log; replay may be incomplete.');
    expect(cmd).not.toContain('_amcp_truncated');
    expect(cmd).toContain('"validKey":"value"');
  });

  test('redacts sensitive keys including auth, pwd, jwt, session, bearer, access_key without false positives', () => {
    const sensitiveArgs = {
      author: 'alice', // must NOT be redacted
      authority: 'gov', // must NOT be redacted
      auth: 'secret-auth', // must be redacted
      authHeader: 'auth-header-val', // must be redacted
      client_auth: 'client-auth-val', // must be redacted
      user_pwd: 'secret-pwd', // must be redacted
      id_jwt: 'jwt-val', // must be redacted
      session_id: 'session-val', // must be redacted
      bearer_token: 'bearer-val', // must be redacted
      access_key: 'access-key-val', // must be redacted
      apiKey: 'api-key-val', // must be redacted
      nested: {
        safe: 'normal_val',
        private_key: 'priv-key-val',
      },
    };

    const redacted = redactSensitiveArgs(sensitiveArgs) as any;
    expect(redacted.author).toBe('alice');
    expect(redacted.authority).toBe('gov');
    expect(redacted.auth).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.authHeader).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.client_auth).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.user_pwd).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.id_jwt).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.session_id).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.bearer_token).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.access_key).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.nested.safe).toBe('normal_val');
    expect(redacted.nested.private_key).toBe(REDACTED_PLACEHOLDER);
  });

  test('redacts sensitive values including JWTs, private keys, Bearer headers, and known API token prefixes', () => {
    const sensitiveValues = {
      rawJwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      rawPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
      bearerHeader: 'Bearer my-bearer-token-1234567890',
      openAiKey: 'sk-proj-1234567890abcdef1234567890',
      githubToken: 'ghp_1234567890abcdef12345678901234567890',
      slackToken: 'xoxb-1234567890-abcdef123456',
      urlWithAuth: 'https://admin:supersecret@example.com/api',
      normalVal: 'hello world',
    };

    const redacted = redactSensitiveArgs(sensitiveValues) as any;
    expect(redacted.rawJwt).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.rawPrivateKey).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.bearerHeader).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.openAiKey).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.githubToken).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.slackToken).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.urlWithAuth).toBe(REDACTED_PLACEHOLDER);
    expect(redacted.normalVal).toBe('hello world');
  });

  test('truncates overly nested structures at MAX_REDACTION_DEPTH to prevent bypass', () => {
    // Construct an object nested 12 levels deep
    let deep: any = { secret_leaf: 'unredacted_payload' };
    for (let i = 0; i < 12; i++) {
      deep = { level: deep };
    }

    const redacted = redactSensitiveArgs(deep) as any;
    // Walk down 10 levels
    let current = redacted;
    for (let i = 0; i < 10; i++) {
      current = current.level;
    }
    // At depth 10, the nested object should be replaced with TRUNCATED_DEPTH_PLACEHOLDER
    expect(current).toBe(TRUNCATED_DEPTH_PLACEHOLDER);
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

  test('copies valid tool call command and shows proper disabled states for shared, truncated, and missing-name rows', async ({
    page,
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

    // 4. Expand fourth row (missing tool name: tool is null)
    await page.getByTitle('t-missing-name').click();
    const missingNameRowDisabled = page.locator('span[title="Replay unavailable: tool name is missing"]');
    await expect(missingNameRowDisabled).toBeVisible();
    const missingNameBtn = missingNameRowDisabled.getByRole('button', { name: 'Copy as cURL' });
    await expect(missingNameBtn).toBeDisabled();
  });
});
