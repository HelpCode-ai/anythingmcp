import axios from 'axios';
import * as adapter from './gamma.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { describeErrorWhenProblems } from '../../connectors/engines/response-error.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Gamma adapter:
 *
 *   1. Static: always runs. Pins the X-API-KEY auth, every tool's method, URL
 *      and body through the real RestEngine, checked against the OpenAPI
 *      documents Gamma embeds in each page of developers.gamma.app (v1.0,
 *      fetched 14 Oct 2026; v0.2 was switched off on 16 Jan 2026) and against
 *      Gamma's own official integration code (credential header, routes, body fields).
 *      Also the failed-job error rule and the response shaping.
 *
 *   2. Live: skipped unless RUN_GAMMA_LIVE=1. Without a key it checks that
 *      Gamma refuses a wrong key with 401 on every real route and answers 404
 *      on a made-up one (no credits are spent: the key is refused first).
 *      With GAMMA_API_KEY it lists themes and folders (free). A real
 *      generation spends credits and only runs with RUN_GAMMA_LIVE_WRITE=1
 *      (one card, no images):
 *
 *        RUN_GAMMA_LIVE=1 GAMMA_API_KEY=sk-gamma-... npx jest src/adapters/intl/gamma.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
  };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const BASE = 'https://public-api.gamma.app';
// Built at runtime so no literal looks like a real credential.
const FAKE_KEY = 'sk-gamma-' + 'x'.repeat(40);
const ENV: Record<string, string> = { GAMMA_API_KEY: FAKE_KEY };

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);

const READ_ONLY = [
  'gamma_get_export',
  'gamma_get_gamma',
  'gamma_get_generation',
  'gamma_list_folders',
  'gamma_list_themes',
  'gamma_search_gammas',
  'gamma_search_templates',
];
const CREDIT_SPENDING = ['gamma_generate', 'gamma_generate_from_template', 'gamma_generate_multi_page'];

describe('gamma adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor SDK and API spec on 14 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
  });

  it('authenticates with the X-API-KEY header on public-api.gamma.app, v1.0 routes', () => {
    expect(a.category).toBe('productivity');
    expect(a.icon).toBe('gamma');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{GAMMA_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1.0/themes?limit=1');
    for (const t of a.tools) expect(t.endpointMapping.path).toMatch(/^\/v1\.0\//);
    expect(a.requiredEnvVars).toEqual(['GAMMA_API_KEY']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'GAMMA_API_KEY', kind: 'credential', secret: true, required: true });
  });

  it('accepts sk-gamma- keys and refuses pasted headers or other vendors', () => {
    const key = new RegExp(a.envVarMeta.GAMMA_API_KEY.pattern!);
    for (const ok of [FAKE_KEY, 'sk-gamma-' + 'Ab1_-'.repeat(6)]) expect(key.test(ok)).toBe(true);
    for (const bad of ['', `X-API-KEY: ${FAKE_KEY}`, 'sk-' + 'x'.repeat(40), `${FAKE_KEY} `, 'sk-gamma-']) expect(key.test(bad)).toBe(false);
  });

  it('probes with a one-theme list and explains a 401 as a key or plan problem', () => {
    expect(a.probe).toEqual({ tool: 'gamma_list_themes', params: { limit: 1 } });
    expect(a.verifyHints['401']).toMatch(/Pro, Ultra, Teams or Business/);
  });

  it('prefixes every tool with gamma_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gamma_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks lookups read-only and asks for confirmation before anything that spends credits or exports', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual(READ_ONLY);
    for (const name of CREDIT_SPENDING) {
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool(name).description).toMatch(/credits/);
      expect(tool(name).description).toMatch(/confirm/);
    }
    expect(annotationsOf(tool('gamma_export_gamma'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool('gamma_export_gamma').description).toMatch(/Confirm/);
    expect(a.tools.every((t) => t.enabled !== false)).toBe(true);
  });

  it('only points the model at tools that exist, documents plan, credits and setup, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgamma_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgamma_[a-z_]+/g), ...JSON.stringify(t.parameters).matchAll(/\bgamma_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toContain('https://gamma.app/settings/api-keys');
    expect(a.instructions).toMatch(/Pro, Ultra, Teams and Business plans/);
    expect(a.instructions).toMatch(/1 to 3 credits per card/);
    expect(a.instructions).toMatch(/no theme-by-name parameter/);
    expect(a.prerequisites).toMatch(/spends Gamma credits/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('carries valid response mappings, none of them a maxBytes-only no-op, and a valid error rule', () => {
    expect(describeErrorWhenProblems(a.connector.config.errorWhen)).toEqual([]);
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) continue;
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['gamma_generate', { inputText: 'Solar energy' }, 'POST', `${BASE}/v1.0/generations`],
    ['gamma_generate_multi_page', { pages: [{ inputText: 'Overview' }] }, 'POST', `${BASE}/v1.0/generations`],
    ['gamma_generate_from_template', { gammaId: 'g_tpl', prompt: 'For HR' }, 'POST', `${BASE}/v1.0/generations/from-template`],
    ['gamma_get_generation', { generationId: 'abc123' }, 'GET', `${BASE}/v1.0/generations/abc123`],
    ['gamma_list_themes', {}, 'GET', `${BASE}/v1.0/themes?limit=20`],
    ['gamma_list_folders', {}, 'GET', `${BASE}/v1.0/folders?limit=20`],
    ['gamma_search_templates', { q: 'review' }, 'GET', `${BASE}/v1.0/templates/search?q=review&limit=10`],
    ['gamma_search_gammas', { createdBy: 'me' }, 'GET', `${BASE}/v1.0/gammas/search?createdBy=me&limit=10`],
    ['gamma_get_gamma', { gammaId: 'g_1' }, 'GET', `${BASE}/v1.0/gammas/g_1`],
    ['gamma_export_gamma', { gammaId: 'g_1', exportAs: 'pdf' }, 'POST', `${BASE}/v1.0/gammas/g_1/export`],
    ['gamma_get_export', { exportId: 'exp_1' }, 'GET', `${BASE}/v1.0/exports/exp_1`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with the X-API-KEY header', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    const full = req.params ? `${req.url}?${new URLSearchParams(req.params).toString()}` : req.url;
    expect(full).toBe(url);
    expect(req.headers['X-API-KEY']).toBe(FAKE_KEY);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('sends only the options given to POST /generations, nested objects as Gamma names them', async () => {
    mockedAxios.mockResolvedValue({ data: { generationId: 'g1' } });
    await call('gamma_generate', { inputText: 'Solar energy' });
    expect(sent().data).toEqual({ inputText: 'Solar energy' });
    mockedAxios.mockClear();
    await call('gamma_generate', {
      inputText: 'Solar energy',
      textMode: 'generate',
      format: 'presentation',
      numCards: 8,
      cardSplit: 'auto',
      title: 'Solar',
      additionalInstructions: 'Use bullet points',
      themeId: 'abcdefghi',
      folderId: 'f1',
      exportAs: 'pptx',
      textOptions: { amount: 'brief', tone: 'upbeat', audience: 'investors', language: 'de' },
      imageOptions: { source: 'aiGenerated', model: 'flux-2-pro', style: 'line art' },
      cardOptions: { dimensions: '16x9', headerFooter: { bottomRight: { type: 'cardNumber' }, hideFromFirstCard: true } },
      sharingOptions: { workspaceAccess: 'view', externalAccess: 'noAccess', emailOptions: { recipients: ['a@example.com'], access: 'comment' } },
    });
    expect(sent().data).toEqual({
      inputText: 'Solar energy',
      textMode: 'generate',
      format: 'presentation',
      numCards: 8,
      cardSplit: 'auto',
      title: 'Solar',
      additionalInstructions: 'Use bullet points',
      themeId: 'abcdefghi',
      folderId: 'f1',
      exportAs: 'pptx',
      textOptions: { amount: 'brief', tone: 'upbeat', audience: 'investors', language: 'de' },
      imageOptions: { source: 'aiGenerated', model: 'flux-2-pro', style: 'line art' },
      cardOptions: { dimensions: '16x9', headerFooter: { bottomRight: { type: 'cardNumber' }, hideFromFirstCard: true } },
      sharingOptions: { workspaceAccess: 'view', externalAccess: 'noAccess', emailOptions: { recipients: ['a@example.com'], access: 'comment' } },
    });
  });

  it('sends pages and publish for a multi-page file, and gammaId plus prompt for a template', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gamma_generate_multi_page', { pages: [{ inputText: 'Overview', numCards: 5 }, { inputText: 'Pricing', path: '/pricing' }], publish: true, themeId: 't1' });
    expect(sent().data).toEqual({ pages: [{ inputText: 'Overview', numCards: 5 }, { inputText: 'Pricing', path: '/pricing' }], publish: true, themeId: 't1' });
    mockedAxios.mockClear();
    await call('gamma_generate_from_template', { gammaId: 'g_tpl', prompt: 'For HR', imageOptions: { model: 'flux-2-pro' }, exportAs: 'pdf' });
    expect(sent().data).toEqual({ gammaId: 'g_tpl', prompt: 'For HR', imageOptions: { model: 'flux-2-pro' }, exportAs: 'pdf' });
    mockedAxios.mockClear();
    await call('gamma_export_gamma', { gammaId: 'g_1', exportAs: 'png' });
    expect(sent().data).toEqual({ exportAs: 'png' });
  });

  it('shapes a completed generation into URL, export link and credits', () => {
    const raw = {
      generationId: 'abc123',
      status: 'completed',
      gammaId: 'g_9',
      gammaUrl: 'https://gamma.app/docs/abc',
      exportUrl: 'https://assets.gamma.app/export.pdf',
      credits: { deducted: 42, remaining: 958 },
    };
    expect(shape('gamma_get_generation', raw).value).toEqual(raw);
    expect(shape('gamma_get_generation', { generationId: 'abc123', status: 'pending' }).value).toEqual({ generationId: 'abc123', status: 'pending' });
  });

  it('turns a failed generation or export into an error carrying Gamma message', async () => {
    mockedAxios.mockResolvedValue({ data: { generationId: 'abc123', status: 'failed', error: { message: 'Content policy', statusCode: 400 }, credits: { deducted: 0, remaining: 1000 } } });
    await expect(call('gamma_get_generation', { generationId: 'abc123' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Content policy') });
    mockedAxios.mockResolvedValue({ data: { exportId: 'e1', status: 'failed', exportAs: 'pdf', gammaId: 'g', error: { reason: 'render_timeout', message: 'Render timed out', statusCode: 504 } } });
    await expect(call('gamma_get_export', { exportId: 'e1' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Render timed out') });
    mockedAxios.mockResolvedValue({ data: { generationId: 'abc123', status: 'pending' } });
    await expect(call('gamma_get_generation', { generationId: 'abc123' })).resolves.toEqual({ generationId: 'abc123', status: 'pending' });
  });

  it('shapes themes, folders, template and gamma searches', () => {
    expect(
      shape('gamma_list_themes', {
        data: [{ id: 'abcdefghi', name: 'Prism', type: 'custom', colorKeywords: ['blue'], toneKeywords: ['playful'], extra: 1 }],
        hasMore: false,
        nextCursor: null,
      }).value,
    ).toEqual({ themes: [{ id: 'abcdefghi', name: 'Prism', type: 'custom', colorKeywords: ['blue'], toneKeywords: ['playful'] }], hasMore: false, nextCursor: null });
    expect(shape('gamma_list_folders', { data: [{ id: 'f1', name: 'Sales' }], hasMore: true, nextCursor: 'c2' }).value).toEqual({
      folders: [{ id: 'f1', name: 'Sales' }],
      hasMore: true,
      nextCursor: 'c2',
    });
    expect(
      shape('gamma_search_templates', {
        workspaceTemplates: [{ id: 't1', title: 'QBR', url: 'https://gamma.app/docs/t1', previewUrl: 'https://img' }],
        exploreTemplates: [{ id: 'x1', title: 'Pitch', url: 'https://gamma.app/x1', thumbnailUrl: 'https://t', previewUrl: null }],
      }).value,
    ).toEqual({
      workspaceTemplates: [{ id: 't1', title: 'QBR', url: 'https://gamma.app/docs/t1' }],
      exploreTemplates: [{ id: 'x1', title: 'Pitch', url: 'https://gamma.app/x1' }],
    });
    const hit = { id: 'g1', title: 'Deck', url: 'https://gamma.app/docs/g1', highlight: 'solar', createdBy: 'Ada', updatedTime: '2026-10-01T00:00:00Z', archived: false };
    expect(shape('gamma_search_gammas', { hits: [hit] }).value).toEqual({ hits: [hit] });
    expect(shape('gamma_get_export', { exportId: 'e1', status: 'completed', exportAs: 'pdf', gammaId: 'g1', exportUrl: 'https://x' }).value).toEqual({
      exportId: 'e1',
      status: 'completed',
      exportAs: 'pdf',
      gammaId: 'g1',
      exportUrl: 'https://x',
    });
  });
});

const live = process.env.RUN_GAMMA_LIVE === '1' ? describe : describe.skip;
live('gamma adapter: live', () => {
  const realKey = process.env.GAMMA_API_KEY;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each<[string, Record<string, unknown>]>([
    ['gamma_generate', { inputText: 'x', numCards: 1 }],
    ['gamma_generate_multi_page', { pages: [{ inputText: 'x' }] }],
    ['gamma_generate_from_template', { gammaId: 'x', prompt: 'x' }],
    ['gamma_get_generation', { generationId: 'abc123' }],
    ['gamma_list_themes', { limit: 1 }],
    ['gamma_list_folders', { limit: 1 }],
    ['gamma_search_templates', { q: 'x', limit: 1 }],
    ['gamma_search_gammas', { q: 'x', limit: 1 }],
    ['gamma_get_gamma', { gammaId: 'abc123' }],
    ['gamma_export_gamma', { gammaId: 'abc123', exportAs: 'pdf' }],
    ['gamma_get_export', { exportId: 'abc123' }],
  ])('%s reaches a real route that refuses a wrong key with 401', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers 404 on a made-up route', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ url: `${BASE}/v1.0/does-not-exist`, headers: { 'X-API-KEY': FAKE_KEY } }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (realKey ? it : it.skip)('lists themes and folders with a real key', async () => {
    const env = { GAMMA_API_KEY: realKey! };
    const themes = shape('gamma_list_themes', await call('gamma_list_themes', { limit: 3 }, env)).value as any;
    expect(themes.themes.length).toBeGreaterThan(0);
    expect(themes.themes[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
    const folders = shape('gamma_list_folders', await call('gamma_list_folders', { limit: 3 }, env)).value as any;
    expect(Array.isArray(folders.folders)).toBe(true);
  }, 60000);

  (realKey && process.env.RUN_GAMMA_LIVE_WRITE === '1' ? it : it.skip)(
    'generates a one-card draft without images (spends a few credits) and polls it',
    async () => {
      const env = { GAMMA_API_KEY: realKey! };
      const started = await call('gamma_generate', { inputText: 'AnythingMCP live test', numCards: 1, imageOptions: { source: 'noImages' } }, env);
      expect(started.generationId).toEqual(expect.any(String));
      let status: any = { status: 'pending' };
      for (let i = 0; i < 24 && status.status === 'pending'; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        status = shape('gamma_get_generation', await call('gamma_get_generation', { generationId: started.generationId }, env)).value;
      }
      expect(status).toMatchObject({ status: 'completed', gammaUrl: expect.stringContaining('gamma.app') });
      expect(status.credits).toEqual(expect.objectContaining({ deducted: expect.any(Number) }));
    },
    180000,
  );
});
