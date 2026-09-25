import * as adapter from './google-search-console.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers of verification for the Google Search Console adapter:
 *
 *   1. Static — always runs. Pins the two things that make this connector
 *      unusual. Every property and sitemap identifier is itself a URL
 *      (`https://www.example.com/`), and it goes in the request PATH: sent
 *      verbatim, its slashes split the path and Google answers 404, so every
 *      tool that interpolates one must opt into encodePathParams. And the
 *      Search Analytics and URL Inspection reads are POSTs, which the
 *      annotation derivation would call writes, so the adapter declares them
 *      read-only itself.
 *
 *   2. Live — skipped unless RUN_GSC_LIVE is set. Needs a Google access token
 *      with a webmasters scope and a property it can read:
 *
 *        RUN_GSC_LIVE=1 GSC_ACCESS_TOKEN=ya29... GSC_SITE_URL=sc-domain:example.com \
 *          npx jest src/adapters/intl/google-search-console.live.spec.ts
 *
 *      A token is quickest from the OAuth 2.0 Playground with the
 *      webmasters.readonly scope; it lasts an hour.
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    staticResponse?: string;
  };
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    healthcheckPath: string;
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  });

const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );

const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
});

describe('google-search-console adapter — static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('authorises in the browser and asks Google for a refresh token', () => {
    const auth = a.connector.authConfig;
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(auth.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    // Without access_type=offline Google issues no refresh token and the
    // connector dies an hour after authorising; without prompt=consent a
    // re-authorisation returns none either.
    const url = new URL(auth.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(auth.scopes).toBe('https://www.googleapis.com/auth/webmasters');
    expect(auth.refreshToken).toBeUndefined();
  });

  it('encodes the path of every tool that interpolates a property or sitemap', () => {
    for (const t of a.tools) {
      if (/\{(site_url|feedpath)\}/.test(t.endpointMapping.path)) {
        expect({ tool: t.name, encode: t.endpointMapping.encodePathParams }).toEqual({
          tool: t.name,
          encode: true,
        });
      }
    }
  });

  it.each([
    ['gsc_list_sites', {}, 'GET', '/webmasters/v3/sites'],
    [
      'gsc_get_site',
      { site_url: 'https://www.example.com/' },
      'GET',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F',
    ],
    [
      'gsc_query_search_analytics',
      { site_url: 'sc-domain:example.com', startDate: '2026-08-01', endDate: '2026-08-28' },
      'POST',
      '/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
    ],
    [
      'gsc_list_sitemaps',
      { site_url: 'https://www.example.com/' },
      'GET',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps',
    ],
    [
      'gsc_get_sitemap',
      { site_url: 'https://www.example.com/', feedpath: 'https://www.example.com/sitemap.xml' },
      'GET',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps/https%3A%2F%2Fwww.example.com%2Fsitemap.xml',
    ],
    [
      'gsc_submit_sitemap',
      { site_url: 'https://www.example.com/', feedpath: 'https://www.example.com/sitemap.xml' },
      'PUT',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps/https%3A%2F%2Fwww.example.com%2Fsitemap.xml',
    ],
    [
      'gsc_delete_sitemap',
      { site_url: 'https://www.example.com/', feedpath: 'https://www.example.com/sitemap.xml' },
      'DELETE',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/sitemaps/https%3A%2F%2Fwww.example.com%2Fsitemap.xml',
    ],
    [
      'gsc_add_site',
      { site_url: 'sc-domain:example.com' },
      'PUT',
      '/webmasters/v3/sites/sc-domain%3Aexample.com',
    ],
    [
      'gsc_remove_site',
      { site_url: 'https://www.example.com/' },
      'DELETE',
      '/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F',
    ],
    [
      'gsc_inspect_url',
      { site_url: 'https://www.example.com/', inspectionUrl: 'https://www.example.com/a' },
      'POST',
      '/v1/urlInspection/index:inspect',
    ],
  ])('%s sends %s to the right Google URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await newEngine().execute(connectorConfig(), tool(name).endpointMapping, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `https://searchconsole.googleapis.com${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('keeps the property out of the Search Analytics body and sends only what was given', async () => {
    mockedAxios.mockResolvedValue({ data: { rows: [] } });
    await newEngine().execute(
      connectorConfig(),
      tool('gsc_query_search_analytics').endpointMapping,
      {
        site_url: 'sc-domain:example.com',
        startDate: '2026-08-01',
        endDate: '2026-08-28',
        dimensions: ['query', 'page'],
        rowLimit: 5000,
      },
    );
    expect(mockedAxios.mock.calls[0][0].data).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-28',
      dimensions: ['query', 'page'],
      rowLimit: 5000,
    });
  });

  it('sends the property raw in the URL Inspection body, where Google expects it unencoded', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await newEngine().execute(connectorConfig(), tool('gsc_inspect_url').endpointMapping, {
      site_url: 'https://www.example.com/',
      inspectionUrl: 'https://www.example.com/a',
    });
    expect(mockedAxios.mock.calls[0][0].data).toEqual({
      inspectionUrl: 'https://www.example.com/a',
      siteUrl: 'https://www.example.com/',
    });
  });

  it('advertises the POST reads as read-only and every real write as a write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'gsc_get_site',
      'gsc_get_sitemap',
      'gsc_inspect_url',
      'gsc_list_sitemaps',
      'gsc_list_sites',
      'gsc_query_search_analytics',
      'gsc_seo_playbook',
    ]);
    expect(annotationsOf(tool('gsc_submit_sitemap'))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotationsOf(tool('gsc_add_site'))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotationsOf(tool('gsc_delete_sitemap'))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(annotationsOf(tool('gsc_remove_site'))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgsc_[a-z_]+/g),
      ...tool('gsc_seo_playbook').endpointMapping.staticResponse!.matchAll(/\bgsc_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgsc_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
  });

  it('probes the connection on an endpoint every account can read', () => {
    expect(a.connector.healthcheckPath).toBe('/webmasters/v3/sites');
  });
});

const live = process.env.RUN_GSC_LIVE ? describe : describe.skip;

live('google-search-console adapter — live API', () => {
  const token = process.env.GSC_ACCESS_TOKEN ?? '';
  const siteUrl = process.env.GSC_SITE_URL ?? '';
  const liveConfig = () => ({
    baseUrl: a.connector.baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token },
  });

  beforeAll(() => {
    if (!token || !siteUrl) throw new Error('Set GSC_ACCESS_TOKEN and GSC_SITE_URL');
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const run = (name: string, params: Record<string, unknown>) =>
    newEngine().execute(liveConfig(), tool(name).endpointMapping, params) as Promise<any>;

  const isoDaysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('lists the property under test', async () => {
    const out = await run('gsc_list_sites', {});
    expect(out.siteEntry.map((s: { siteUrl: string }) => s.siteUrl)).toContain(siteUrl);
  }, 30_000);

  it('reads the property through its encoded path', async () => {
    const out = await run('gsc_get_site', { site_url: siteUrl });
    expect(out.siteUrl).toBe(siteUrl);
  }, 30_000);

  it('returns Search Analytics rows grouped by query', async () => {
    const out = await run('gsc_query_search_analytics', {
      site_url: siteUrl,
      startDate: isoDaysAgo(31),
      endDate: isoDaysAgo(3),
      dimensions: ['query'],
      rowLimit: 5,
    });
    expect(out.responseAggregationType).toBeDefined();
    for (const row of out.rows ?? []) {
      expect(row.keys).toHaveLength(1);
      expect(typeof row.clicks).toBe('number');
      expect(typeof row.position).toBe('number');
    }
  }, 30_000);

  it('lists sitemaps', async () => {
    const out = await run('gsc_list_sitemaps', { site_url: siteUrl });
    expect(out).toBeDefined();
  }, 30_000);

  it('inspects the property home page', async () => {
    const home = siteUrl.startsWith('sc-domain:')
      ? `https://${siteUrl.slice('sc-domain:'.length)}/`
      : siteUrl;
    const out = await run('gsc_inspect_url', { site_url: siteUrl, inspectionUrl: home });
    expect(out.inspectionResult.indexStatusResult.verdict).toBeDefined();
  }, 30_000);
});
