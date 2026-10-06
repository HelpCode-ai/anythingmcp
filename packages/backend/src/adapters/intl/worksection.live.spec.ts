import * as adapter from './worksection.json';

type Tool = {
  name: string;
  annotations?: Record<string, boolean>;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams: Record<string, string>;
    bodyEncoding?: string;
    bodyMapping?: Record<string, string>;
  };
};
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  probe: { tool: string };
  tools: Tool[];
};
const WRITE_ACTIONS = new Set([
  'post_task', 'update_task', 'complete_task', 'reopen_task', 'update_task_tags',
  'post_comment', 'add_costs', 'start_my_timer', 'stop_my_timer',
]);

describe('worksection adapter: static spec conformance', () => {
  it('OAuth 2.0 user token against the account host (the admin MD5 hash cannot be expressed)', () => {
    expect(a.connector.baseUrl).toBe('{{WORKSECTION_URL}}');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      authorizationUrl: 'https://worksection.com/oauth2/authorize',
      tokenUrl: 'https://worksection.com/oauth2/token',
    });
  });

  it('every tool calls /api/oauth2 with a fixed action', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.path).toBe('/api/oauth2');
      expect(t.endpointMapping.queryParams.action).toMatch(/^[a-z_]+$/);
    }
  });

  it('reads are GET, writes are POST with a form body', () => {
    for (const t of a.tools) {
      const action = t.endpointMapping.queryParams.action;
      if (WRITE_ACTIONS.has(action)) {
        expect(t.endpointMapping.method).toBe('POST');
        if (t.endpointMapping.bodyMapping) expect(t.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      } else {
        expect(t.endpointMapping.method).toBe('GET');
      }
    }
  });

  it('asks for the scopes the tools need, not the administrative scope', () => {
    const scopes = a.connector.authConfig.scopes.split(' ');
    expect(scopes).toEqual(expect.arrayContaining(['projects_read', 'tasks_read', 'tasks_write', 'comments_write', 'costs_write']));
    expect(scopes).not.toContain('administrative');
  });

  it('probe is me (OAuth only)', () => expect(a.probe.tool).toBe('worksection_get_me'));
});
