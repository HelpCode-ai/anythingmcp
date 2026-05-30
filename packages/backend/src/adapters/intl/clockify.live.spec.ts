import * as adapter from './clockify.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Two-tier verification (pattern: pipedrive, weclapp).
 *
 *  1. Static — always runs in CI. Asserts the adapter shape matches Clockify
 *     REST conventions: api.clockify.me/api/v1 base, API_KEY via X-Api-Key,
 *     the workspace-scoped tool paths, and that the report tools escape to the
 *     separate reports.api.clockify.me host via absolute URLs.
 *
 *  2. Live — opt-in. Runs the REAL RestEngine against production Clockify with
 *     a real key supplied via env (never committed):
 *       RUN_CLOCKIFY_LIVE=1 CLOCKIFY_API_KEY=xxx npx jest src/adapters/intl/clockify.live.spec.ts
 *     Without a key it falls back to a bogus-key edge check (expects 401).
 */

interface Tool {
  name: string;
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, string>;
  };
}

const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};

describe('clockify adapter — static spec conformance', () => {
  it('api.clockify.me/api/v1 base URL', () =>
    expect(a.connector.baseUrl).toBe('https://api.clockify.me/api/v1'));

  it('X-Api-Key auth header', () => {
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('X-Api-Key');
    expect(a.connector.authConfig.apiKey).toBe('{{CLOCKIFY_API_KEY}}');
    expect(a.requiredEnvVars).toEqual(['CLOCKIFY_API_KEY']);
  });

  it('exposes the workspace-users tool that custom connectors were missing', () => {
    const t = a.tools.find((x) => x.name === 'clockify_list_workspace_users');
    expect(t).toBeDefined();
    expect(t!.endpointMapping.method).toBe('GET');
    expect(t!.endpointMapping.path).toBe('/workspaces/{workspace_id}/users');
  });

  it('covers tasks + create tools', () => {
    const expected = [
      ['clockify_find_tasks', 'GET', '/workspaces/{workspace_id}/projects/{project_id}/tasks'],
      ['clockify_add_task', 'POST', '/workspaces/{workspace_id}/projects/{project_id}/tasks'],
      ['clockify_add_project', 'POST', '/workspaces/{workspace_id}/projects'],
      ['clockify_add_client', 'POST', '/workspaces/{workspace_id}/clients'],
      ['clockify_add_tag', 'POST', '/workspaces/{workspace_id}/tags'],
    ];
    for (const [name, method, path] of expected) {
      const t = a.tools.find((x) => x.name === name);
      expect(t).toBeDefined();
      expect(t!.endpointMapping.method).toBe(method);
      expect(t!.endpointMapping.path).toBe(path);
    }
  });

  it('routes report tools to the separate reports.api host via absolute URLs', () => {
    for (const name of ['clockify_detailed_report', 'clockify_summary_report']) {
      const t = a.tools.find((x) => x.name === name)!;
      expect(t).toBeDefined();
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.path.startsWith('https://reports.api.clockify.me/v1/')).toBe(true);
    }
  });

  it('ships 18 tools', () => {
    expect(a.tools.length).toBe(18);
  });
});

const live = process.env.RUN_CLOCKIFY_LIVE ? describe : describe.skip;

live('clockify adapter — live (real RestEngine against production)', () => {
  const oauth = {} as unknown as OAuth2TokenService;
  const loginToken = {} as unknown as LoginTokenService;
  const engine = new RestEngine(oauth, loginToken);
  const apiKey = process.env.CLOCKIFY_API_KEY || 'bogus-key-for-edge-validation';
  const hasRealKey = !!process.env.CLOCKIFY_API_KEY;
  const authConfig = { headerName: 'X-Api-Key', apiKey };

  it('GET /user reaches Clockify and (with a real key) returns the profile', async () => {
    let res: any, err: any;
    try {
      res = await engine.execute(
        { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig },
        { method: 'GET', path: '/user' },
        {},
      );
    } catch (e) {
      err = e;
    }
    if (hasRealKey) {
      expect(err).toBeUndefined();
      expect(res.id).toBeDefined();
      expect(res.activeWorkspace).toBeDefined();
    } else {
      expect(err?.response?.status).toBe(401);
    }
  }, 30000);

  it('GET workspace users path resolves (the tool Ram needed)', async () => {
    if (!hasRealKey) return;
    const me: any = await engine.execute(
      { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig },
      { method: 'GET', path: '/user' },
      {},
    );
    const users: any = await engine.execute(
      { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig },
      {
        method: 'GET',
        path: '/workspaces/{workspace_id}/users',
        queryParams: { 'page-size': '$page_size' },
      },
      { workspace_id: me.activeWorkspace, page_size: 5 },
    );
    expect(Array.isArray(users)).toBe(true);
  }, 30000);

  it('detailed report escapes to reports.api host through the engine', async () => {
    if (!hasRealKey) return;
    const me: any = await engine.execute(
      { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig },
      { method: 'GET', path: '/user' },
      {},
    );
    const report: any = await engine.execute(
      { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig },
      {
        method: 'POST',
        path: 'https://reports.api.clockify.me/v1/workspaces/{workspace_id}/reports/detailed',
        bodyMapping: {
          dateRangeStart: '$date_range_start',
          dateRangeEnd: '$date_range_end',
          detailedFilter: '$detailed_filter',
        },
      },
      {
        workspace_id: me.activeWorkspace,
        date_range_start: '2026-05-01T00:00:00.000',
        date_range_end: '2026-05-31T23:59:59.999',
        detailed_filter: { page: 1, pageSize: 5 },
      },
    );
    expect(report.totals).toBeDefined();
  }, 30000);
});
