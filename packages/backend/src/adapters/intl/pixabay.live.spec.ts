import axios from 'axios';
import * as adapter from './pixabay.json';

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

describe('pixabay adapter — static spec conformance', () => {
  it('connects to pixabay.com/api with QUERY_AUTH key', () => {
    expect(a.slug).toBe('pixabay');
    expect(a.name).toBe('Pixabay');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('publishing');
    expect(a.connector.baseUrl).toBe('https://pixabay.com/api');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{PIXABAY_API_KEY}}' });
    expect(a.requiredEnvVars).toContain('PIXABAY_API_KEY');
  });

  it('exposes exactly 2 read-only tools prefixed with pixabay_', () => {
    expect(a.tools).toHaveLength(2);
    const names = a.tools.map((t) => t.name);
    expect(names).toEqual(['pixabay_search_images', 'pixabay_search_videos']);
    for (const t of a.tools) {
      expect(t.name.startsWith('pixabay_')).toBe(true);
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.responseMapping?.transform?.select).toBeDefined();
    }
  });

  it('probe uses a valid read-only tool', () => {
    expect(a.probe.tool).toBe('pixabay_search_images');
    const p = tool(a.probe.tool);
    expect(p.endpointMapping.method).toBe('GET');
    expect(a.probe.params).toBeDefined();
  });

  it('maps correct endpoints for image and video search', () => {
    const images = tool('pixabay_search_images');
    expect(images.endpointMapping.path).toBe('/');
    expect(images.endpointMapping.queryParams).toBeDefined();

    const videos = tool('pixabay_search_videos');
    expect(videos.endpointMapping.path).toBe('/videos/');
    expect(videos.endpointMapping.queryParams).toBeDefined();
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

describe('pixabay adapter — live integration', () => {
  const live = process.env.RUN_PIXABAY_LIVE === '1' && process.env.PIXABAY_API_KEY ? it : it.skip;

  live('GET https://pixabay.com/api/ returns image hits', async () => {
    const response = await axios.get('https://pixabay.com/api/', {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: 'nature',
        per_page: 3,
      },
      headers: {
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('hits');
    expect(Array.isArray(response.data.hits)).toBe(true);
  });
});
