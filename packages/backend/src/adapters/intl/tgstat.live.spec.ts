import axios from 'axios';
import * as adapter from './tgstat.json';

type Tool = {
  name: string;
  description: string;
  parameters?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
  };
  responseMapping?: {
    transform?: {
      select?: Record<string, unknown>;
    };
  };
};

const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  probe: {
    tool: string;
    params?: Record<string, unknown>;
  };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const refs = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (/^\$\w+$/.test(v)) out.add(v.slice(1));
    for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) refs(x, out);
  }
};

describe('tgstat adapter — static spec conformance', () => {
  it('connects to api.tgstat.ru with QUERY_AUTH token', () => {
    expect(a.slug).toBe('tgstat');
    expect(a.name).toBe('TGStat');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('analytics');
    expect(a.connector.baseUrl).toBe('https://api.tgstat.ru');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ token: '{{TGSTAT_API_TOKEN}}' });
    expect(a.requiredEnvVars).toContain('TGSTAT_API_TOKEN');
  });

  it('exposes exactly 4 read-only tools prefixed with tgstat_', () => {
    expect(a.tools).toHaveLength(4);
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual([
      'tgstat_get_channel_info',
      'tgstat_get_channel_stats',
      'tgstat_search_posts',
      'tgstat_get_post_stats',
    ]);
    for (const t of a.tools) {
      expect(t.name.startsWith('tgstat_')).toBe(true);
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.responseMapping?.transform?.select).toBeDefined();
    }
  });

  it('probe uses a valid read-only tool', () => {
    expect(a.probe.tool).toBe('tgstat_get_channel_info');
    const p = tool(a.probe.tool);
    expect(p.endpointMapping.method).toBe('GET');
    expect(a.probe.params).toBeDefined();
  });

  it('maps correct endpoints for channels and posts', () => {
    const channelInfo = tool('tgstat_get_channel_info');
    expect(channelInfo.endpointMapping.path).toBe('/channels/get');
    expect(channelInfo.endpointMapping.queryParams).toBeDefined();

    const channelStats = tool('tgstat_get_channel_stats');
    expect(channelStats.endpointMapping.path).toBe('/channels/stat');
    expect(channelStats.endpointMapping.queryParams).toBeDefined();

    const searchPosts = tool('tgstat_search_posts');
    expect(searchPosts.endpointMapping.path).toBe('/posts/search');
    expect(searchPosts.endpointMapping.queryParams).toBeDefined();

    const postStats = tool('tgstat_get_post_stats');
    expect(postStats.endpointMapping.path).toBe('/posts/stat');
    expect(postStats.endpointMapping.queryParams).toBeDefined();
  });

  it('every declared parameter reaches queryParams', () => {
    for (const t of a.tools) {
      const used = new Set<string>();
      refs(t.endpointMapping.queryParams, used);
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      }
    }
  });
});

describe('tgstat adapter — live integration', () => {
  const live = process.env.RUN_TGSTAT_LIVE === '1' && process.env.TGSTAT_API_TOKEN ? it : it.skip;

  live('GET https://api.tgstat.ru/channels/get returns channel profile', async () => {
    const response = await axios.get('https://api.tgstat.ru/channels/get', {
      params: {
        token: process.env.TGSTAT_API_TOKEN,
        channelId: '@telegram',
      },
      headers: {
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('status');
  });
});
