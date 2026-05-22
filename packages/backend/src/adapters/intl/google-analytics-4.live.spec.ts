import * as adapter from './google-analytics-4.json';
const a = adapter as unknown as {
  connector: { baseUrl: string; authType: string; authConfig: { tokenUrl: string } };
  tools: Array<{ name: string; endpointMapping: { path: string } }>;
};
describe('google-analytics-4 adapter — static spec conformance', () => {
  it('baseUrl points at the Admin host (Data endpoints use absolute URLs)', () =>
    expect(a.connector.baseUrl).toBe('https://analyticsadmin.googleapis.com'));
  it('OAuth2 against the standard Google token endpoint', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig.tokenUrl).toBe('https://oauth2.googleapis.com/token');
  });
  it('reporting tools target analyticsdata.googleapis.com via absolute URL', () => {
    // The engine routes absolute URLs out of the connector's baseUrl, so a
    // single adapter can hit both googleanalytics hosts. Regression-guard
    // the Data API hostname so a refactor doesn't silently drop reports
    // onto the Admin host (where they 404).
    const reportTools = a.tools.filter((t) => /_run_.*report$/.test(t.name));
    expect(reportTools.length).toBeGreaterThanOrEqual(3);
    for (const t of reportTools) {
      try {
        const u = new URL(t.endpointMapping.path);
        expect(u.hostname).toBe('analyticsdata.googleapis.com');
      } catch {
        throw new Error(`${t.name} path is not an absolute URL: ${t.endpointMapping.path}`);
      }
    }
  });
  it('admin metadata tools target analyticsadmin.googleapis.com', () => {
    const adminTools = a.tools.filter(
      (t) => /get_(account|property)|list_(google_ads|custom_)/.test(t.name),
    );
    expect(adminTools.length).toBeGreaterThanOrEqual(3);
    for (const t of adminTools) {
      const u = new URL(t.endpointMapping.path);
      expect(u.hostname).toBe('analyticsadmin.googleapis.com');
    }
  });
  it('exposes the 7 tools mirroring the upstream MCP server', () => {
    const names = a.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ga4_get_account_summaries',
      'ga4_get_property_details',
      'ga4_list_custom_dimensions',
      'ga4_list_custom_metrics',
      'ga4_list_google_ads_links',
      'ga4_run_funnel_report',
      'ga4_run_realtime_report',
      'ga4_run_report',
    ]);
  });
});
