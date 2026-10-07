import * as adapter from './scopevisio.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, string>;
  };
  annotations?: { readOnlyHint?: boolean };
};

const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Scopevisio adapter: static contract', () => {
  it('signs in with the password grant at /rest/token, form-encoded', () => {
    expect(a.requiredEnvVars).toEqual([
      'SCOPEVISIO_CUSTOMER',
      'SCOPEVISIO_USERNAME',
      'SCOPEVISIO_PASSWORD',
      'SCOPEVISIO_ORGANISATION',
    ]);
    expect(a.connector.baseUrl).toBe('https://appload.scopevisio.com/rest');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    const auth = a.connector.authConfig;
    expect(auth.loginUrl).toBe('https://appload.scopevisio.com/rest/token');
    expect((auth.loginHeaders as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(auth.loginBody).toEqual({
      grant_type: 'password',
      customer: '{{SCOPEVISIO_CUSTOMER}}',
      username: '${username}',
      password: '${password}',
      organisation: '{{SCOPEVISIO_ORGANISATION}}',
    });
    expect(auth.tokenJsonPath).toBe('access_token');
    expect(auth.expiryJsonPath).toBe('expires_in');
    expect(auth.expiryFormat).toBe('ttl_seconds');
    expect(auth.refreshOn401).toBe(true);
    expect(auth.headerTemplate).toBe('Bearer ${token}');
    expect(new RegExp(a.envVarMeta.SCOPEVISIO_CUSTOMER.pattern!).test('1234567')).toBe(true);
    expect(new RegExp(a.envVarMeta.SCOPEVISIO_CUSTOMER.pattern!).test('https://evil.example')).toBe(false);
    expect(a.envVarMeta.SCOPEVISIO_PASSWORD.secret).toBe(true);
  });

  it('keeps the tool names installed connectors match on, on the paths of the OpenAPI spec', () => {
    const expected: Record<string, [string, string]> = {
      scopevisio_list_contacts: ['POST', '/contacts'],
      scopevisio_get_contact: ['GET', '/contact/{contactId}'],
      scopevisio_list_outgoing_invoices: ['POST', '/outgoinginvoices'],
      scopevisio_list_incoming_invoices: ['POST', '/incominginvoices'],
      scopevisio_list_projects: ['POST', '/projects'],
      scopevisio_list_tasks: ['POST', '/tasks'],
      scopevisio_get_account: ['GET', '/myaccount'],
      scopevisio_get_project: ['GET', '/project/{projectId}'],
      scopevisio_get_task: ['GET', '/task/{taskId}'],
    };
    for (const [name, [method, path]] of Object.entries(expected)) {
      expect({ name, method: byName[name]?.endpointMapping.method, path: byName[name]?.endpointMapping.path }).toEqual({
        name,
        method,
        path,
      });
    }
    expect(a.tools.every((tool) => tool.name.startsWith('scopevisio_'))).toBe(true);
    expect(a.probe.tool).toBe('scopevisio_get_account');
  });

  it('sends the documented search body and marks the POST searches read-only', () => {
    const posts = a.tools.filter((tool) => tool.endpointMapping.method === 'POST');
    expect(posts.length).toBe(5);
    for (const tool of posts) {
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      expect(tool.endpointMapping.bodyMapping).toMatchObject({
        search: '$search',
        fields: '$fields',
        order: '$order',
        page: '$page',
        pageSize: '$pageSize',
      });
    }
    expect(a.tools.every((tool) => ['GET', 'POST'].includes(tool.endpointMapping.method))).toBe(true);
    expect(a.instructions).not.toContain('—');
  });
});

// Opt-in: RUN_SCOPEVISIO_LIVE=1. The first check needs no account; the second needs
// SCOPEVISIO_CUSTOMER, SCOPEVISIO_USERNAME, SCOPEVISIO_PASSWORD and SCOPEVISIO_ORGANISATION.
const live = process.env.RUN_SCOPEVISIO_LIVE === '1';
(live ? describe : describe.skip)('Scopevisio: live', () => {
  const base = 'https://appload.scopevisio.com/rest';

  it('refuses wrong credentials at /rest/token with 401', async () => {
    const response = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'password', customer: '0000000', username: 'nobody@example.com', password: 'x' }),
    });
    expect(response.status).toBe(401);
  });

  it('signs in and reads the account and one page of contacts', async () => {
    const env = process.env;
    if (!env.SCOPEVISIO_CUSTOMER || !env.SCOPEVISIO_USERNAME || !env.SCOPEVISIO_PASSWORD || !env.SCOPEVISIO_ORGANISATION) {
      throw new Error('Set the four SCOPEVISIO_* variables for the authenticated live check');
    }
    const login = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'password',
        customer: env.SCOPEVISIO_CUSTOMER,
        username: env.SCOPEVISIO_USERNAME,
        password: env.SCOPEVISIO_PASSWORD,
        organisation: env.SCOPEVISIO_ORGANISATION,
      }),
    });
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { access_token: string }).access_token;
    expect(token).toBeTruthy();

    const account = await fetch(base + '/myaccount', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    expect(account.status).toBe(200);
    const contacts = await fetch(base + '/contacts', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 0, pageSize: 5 }),
    });
    expect(contacts.status).toBe(200);
  });
});
