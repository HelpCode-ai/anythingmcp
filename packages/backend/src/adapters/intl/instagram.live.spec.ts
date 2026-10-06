import * as adapter from './instagram.json';

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
};
const a = adapter as unknown as {
  slug: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('instagram adapter: static spec conformance', () => {
  it('Graph API on graph.facebook.com, versioned', () =>
    expect(a.connector.baseUrl).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.0$/));

  it('Bearer auth with a ready (system user) token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{INSTAGRAM_ACCESS_TOKEN}}');
  });

  it('probe is a read with no required parameters', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
  });

  it('every tool is prefixed and every parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('instagram_')).toBe(true);
      const sent = JSON.stringify(t.endpointMapping.queryParams ?? {});
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        const reached = t.endpointMapping.path.includes(`{${p}}`) || sent.includes(`"$${p}"`) || sent.includes(`\${${p}}`);
        expect({ tool: t.name, param: p, reached }).toEqual({ tool: t.name, param: p, reached: true });
      }
    }
  });

  it('account-scoped tools take the account id from the connector', () => {
    expect(tool('instagram_list_media').endpointMapping.path).toBe('/{{INSTAGRAM_ACCOUNT_ID}}/media');
    expect(tool('instagram_get_account_insights').endpointMapping.path).toBe('/{{INSTAGRAM_ACCOUNT_ID}}/insights');
    expect(tool('instagram_search_hashtag').endpointMapping.queryParams).toMatchObject({ user_id: '{{INSTAGRAM_ACCOUNT_ID}}' });
  });

  it('publishing is installed switched off', () => {
    expect(tool('instagram_create_media_container').enabled).toBe(false);
    expect(tool('instagram_publish_media').enabled).toBe(false);
  });
});
