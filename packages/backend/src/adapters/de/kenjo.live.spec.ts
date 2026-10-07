import * as adapter from './kenjo.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  responseMapping?: { transform?: { exclude?: string[] } };
};

const a = adapter as unknown as {
  slug: string;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Kenjo adapter: static contract', () => {
  it('exchanges the API key for an expiring token at /auth/login', () => {
    expect(a.requiredEnvVars).toEqual(['KENJO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.kenjo.io/api/v1');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://api.kenjo.io/api/v1/auth/login');
    expect(auth.loginBody).toEqual({ apiKey: '${password}' });
    expect(auth.password).toBe('{{KENJO_API_KEY}}');
    expect(auth.tokenJsonPath).toBe('token');
    expect(auth.expiryJsonPath).toBe('X-Expires-After');
    expect(auth.refreshOn401).toBe(true);
    // Kenjo's token already starts with "Bearer ", so it is sent as is.
    expect(auth.headerTemplate).toBe('${token}');
  });

  it('keeps the tool names installed connectors match on, all prefixed and read-only', () => {
    for (const name of [
      'kenjo_list_employees',
      'kenjo_get_employee',
      'kenjo_list_departments',
      'kenjo_list_offices',
      'kenjo_list_positions',
      'kenjo_list_teams',
    ]) {
      expect(byName[name]).toBeDefined();
    }
    expect(a.tools.every((tool) => tool.name.startsWith('kenjo_'))).toBe(true);
    expect(a.tools.every((tool) => tool.endpointMapping.method === 'GET')).toBe(true);
    expect(byName[a.probe.tool]).toBeDefined();
  });

  it('lists employees from /user-accounts, which carries names and job titles', () => {
    expect(byName.kenjo_list_employees.endpointMapping.path).toBe('/user-accounts');
    expect(byName.kenjo_get_employee.endpointMapping.path).toBe('/employees/{employeeId}');
    expect(byName.kenjo_get_employee.responseMapping?.transform?.exclude).toEqual(['financial']);
  });

  it('pages positions and time off with limit 25/50/100 and a 1-based offset', () => {
    for (const name of ['kenjo_list_positions', 'kenjo_list_time_off_requests', 'kenjo_list_time_off_types']) {
      const tool = byName[name];
      expect(tool.endpointMapping.queryParams).toMatchObject({ limit: '$limit', offset: '$offset' });
      expect(tool.endpointMapping.queryParams).not.toHaveProperty('page');
      expect(tool.parameters.properties?.limit.enum).toEqual([25, 50, 100]);
    }
    expect(byName.kenjo_list_time_off_requests.parameters.required).toEqual(['from', 'to']);
    expect(byName.kenjo_list_time_off_requests.endpointMapping.queryParams).toMatchObject({
      _userId: '$userId',
      _timeOffTypeId: '$timeOffTypeId',
    });
    expect(byName.kenjo_list_attendances.parameters.required).toEqual(['from', 'to']);
  });

  it('documents how API access is enabled', () => {
    expect(a.instructions).toContain('Customer Success');
    expect(a.instructions).toContain('Settings > Integrations > API');
    expect(a.instructions).not.toContain('—');
  });
});

// Opt-in: RUN_KENJO_LIVE=1. The first check needs no key; the second needs
// KENJO_API_KEY (and KENJO_API_URL=https://sandbox-api.kenjo.io/api/v1 for a sandbox key).
const live = process.env.RUN_KENJO_LIVE === '1';
(live ? describe : describe.skip)('Kenjo: live', () => {
  const base = process.env.KENJO_API_URL || 'https://api.kenjo.io/api/v1';

  it('answers a wrong key at /auth/login with 401 and a JSON message', async () => {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'not-a-real-key' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 401 });
  });

  it('logs in and lists employees and departments', async () => {
    const key = process.env.KENJO_API_KEY;
    if (!key) throw new Error('Set KENJO_API_KEY for the authenticated live check');
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { token: string; 'X-Expires-After': string };
    expect(body.token.startsWith('Bearer ')).toBe(true);
    expect(Number.isFinite(Date.parse(body['X-Expires-After']))).toBe(true);

    for (const path of ['/user-accounts', '/departments']) {
      const response = await fetch(base + path, { headers: { Authorization: body.token } });
      expect(response.status).toBe(200);
    }
  });
});
