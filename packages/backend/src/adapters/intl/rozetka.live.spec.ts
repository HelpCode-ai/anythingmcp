import * as adapter from './rozetka.json';

type Tool = {
  name: string;
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown> & { loginBody: Record<string, string> };
  };
  tools: Tool[];
};

describe('Rozetka adapter — static contract', () => {
  it('signs in with the cabinet login and the Base64 password, then sends a bearer token', () => {
    expect(a.requiredEnvVars).toEqual(['ROZETKA_USERNAME', 'ROZETKA_PASSWORD_BASE64']);
    expect(a.connector.baseUrl).toBe('https://api-seller.rozetka.com.ua');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: 'https://api-seller.rozetka.com.ua/sites',
      loginMethod: 'POST',
      loginBody: { username: '${username}', password: '${password}' },
      username: '{{ROZETKA_USERNAME}}',
      password: '{{ROZETKA_PASSWORD_BASE64}}',
      tokenJsonPath: 'content.access_token',
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
  });

  it('logs in again well inside the 24-hour idle expiry', () => {
    // Rozetka reports an expired token with HTTP 200, so refreshOn401 never fires;
    // a short local lifetime is what keeps the session valid.
    const ttl = a.connector.authConfig.tokenTTLSeconds as number;
    const early = a.connector.authConfig.proactiveRefreshSeconds as number;
    expect(ttl).toBeLessThan(24 * 3600);
    expect(early).toBeLessThan(ttl);
  });

  it('accepts only a Base64 value for the password', () => {
    const pattern = new RegExp(a.envVarMeta.ROZETKA_PASSWORD_BASE64.pattern as string);
    expect(pattern.test(Buffer.from('my password').toString('base64'))).toBe(true);
    expect(pattern.test('my password!')).toBe(false);
  });

  it('offers read-only tools on the documented paths', () => {
    const routes = Object.fromEntries(
      a.tools.map((tool) => [tool.name, `${tool.endpointMapping.method} ${tool.endpointMapping.path}`]),
    );
    expect(routes).toEqual({
      rozetka_list_orders: 'GET /orders/search',
      rozetka_get_order: 'GET /orders/{id}',
      rozetka_list_order_statuses: 'GET /order-statuses/search',
      rozetka_list_goods: 'GET /goods/all',
      rozetka_get_goods: 'GET /goods/details',
    });
    expect(a.probe.tool).toBe('rozetka_list_order_statuses');
  });
});

// Opt-in: RUN_ROZETKA_LIVE=1. Without credentials it checks the refusal shapes (HTTP 200,
// success:false); with ROZETKA_USERNAME and ROZETKA_PASSWORD_BASE64 it signs in and reads statuses.
const live = process.env.RUN_ROZETKA_LIVE === '1';
(live ? describe : describe.skip)('Rozetka — live login and read-only smoke test', () => {
  const base = 'https://api-seller.rozetka.com.ua';

  it('refuses a wrong login with HTTP 200 and incorrect_username_password', async () => {
    const response = await fetch(base + '/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'amcp-nonexistent-test', password: Buffer.from('wrong').toString('base64') }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.errors.message).toBe('incorrect_username_password');
  }, 30000);

  it('refuses a wrong token with HTTP 200 and incorrect_access_token', async () => {
    const response = await fetch(base + '/order-statuses/search', { headers: { Authorization: 'Bearer invalid' } });
    expect(response.status).toBe(200);
    expect((await response.json()).errors.message).toBe('incorrect_access_token');
  }, 30000);

  const user = process.env.ROZETKA_USERNAME;
  const password = process.env.ROZETKA_PASSWORD_BASE64;
  (user && password ? it : it.skip)('signs in and lists order statuses', async () => {
    const login = await fetch(base + '/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
    });
    const token = (await login.json()).content.access_token as string;
    const response = await fetch(base + '/order-statuses/search', { headers: { Authorization: 'Bearer ' + token } });
    expect((await response.json()).success).toBe(true);
  }, 30000);
});
