import * as adapter from './crewmeister.json';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  responseMapping?: { transform: { exclude?: string[] } };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('crewmeister adapter - static spec conformance', () => {
  it('API v3 on api.crewmeister.com (v2 was retired on 31 March 2026)', () => {
    expect(a.connector.baseUrl).toBe('https://api.crewmeister.com/api/v3');
  });

  it('logs in with e-mail and password and sends the JWT as a bearer token', () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig.loginUrl).toBe('https://api.crewmeister.com/api/v3/auth/user/');
    expect(a.connector.authConfig.loginBody).toEqual({ username: '${username}', password: '${password}' });
    expect(a.connector.authConfig.username).toBe('{{CREWMEISTER_EMAIL}}');
    expect(a.connector.authConfig.password).toBe('{{CREWMEISTER_PASSWORD}}');
    expect(a.connector.authConfig.tokenJsonPath).toBe('token');
    expect(a.connector.authConfig.headerTemplate).toBe('Bearer ${token}');
  });

  it('list tools page with page / pageSize and filter with RSQL', () => {
    for (const t of a.tools.filter((x) => x.name.startsWith('crewmeister_list_'))) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.queryParams).toEqual({ filter: '$filter', sort: '$sort', page: '$page', pageSize: '$page_size' });
    }
  });

  it('computed resources require a filter naming the crew', () => {
    for (const name of [
      'crewmeister_list_absence_entitlements',
      'crewmeister_list_entitlement_balances',
      'crewmeister_list_durations',
      'crewmeister_list_duration_balances',
      'crewmeister_list_calendar_days',
    ]) {
      expect(tool(name).parameters.required).toEqual(['filter']);
      expect(tool(name).parameters.properties!.filter.description).toMatch(/crewId==/);
    }
  });

  it('drops the crew password and member PIN codes from answers', () => {
    expect(tool('crewmeister_list_crews').responseMapping!.transform.exclude).toContain('content[*].password');
    expect(tool('crewmeister_list_members').responseMapping!.transform.exclude).toContain('content[*].pinCode');
  });
});

// Keyless checks of the endpoints the adapter depends on: RUN_CREWMEISTER_LIVE=1.
const live = process.env.RUN_CREWMEISTER_LIVE === '1' ? describe : describe.skip;
live('crewmeister adapter - live (no credentials)', () => {
  it('the login endpoint exists and rejects unknown users with 400', async () => {
    const res = await fetch(String(a.connector.authConfig.loginUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody@example.com', password: 'not-a-password' }),
    });
    expect(res.status).toBe(400);
  });

  it('resources answer 401 without a token', async () => {
    const res = await fetch(`${a.connector.baseUrl}${tool('crewmeister_list_members').endpointMapping.path}`);
    expect(res.status).toBe(401);
  });
});
