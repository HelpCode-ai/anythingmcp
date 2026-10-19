import axios from 'axios';
import * as adapter from './judge-me.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Judge.me adapter (REST API v1):
 *
 *   1. Static: always runs. Pins the private token in X-Api-Token (never in
 *      the URL), shop_domain on every call, every tool's method and URL
 *      through the real RestEngine against Judge.me's published OpenAPI file,
 *      the curation and reply bodies, and which tools are switched off.
 *
 *   2. Live: skipped unless RUN_JUDGEME_LIVE=1, JUDGEME_SHOP_DOMAIN and
 *      JUDGEME_API_TOKEN are set. Reads only: the shop, reviews, counts,
 *      ratings and settings.
 *
 *        RUN_JUDGEME_LIVE=1 JUDGEME_SHOP_DOMAIN=my-store.myshopify.com JUDGEME_API_TOKEN=... \
 *          npx jest src/adapters/intl/judge-me.live.spec.ts
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
  parameters: { properties?: Record<string, any>; required?: string[] };
  endpointMapping: { method: string; path: string; encodePathParams?: boolean; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

// Built at run time so no literal here looks like a real credential.
const TOKEN = ['AbCdEfGhIj', 'KlMnOpQrStUvWxYz12'].join('');
const SHOP = 'my-store.myshopify.com';
const BASE = 'https://api.judge.me/api/v1';
const ENV = { JUDGEME_SHOP_DOMAIN: SHOP, JUDGEME_API_TOKEN: TOKEN };
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
  const c = interpolateDeep(a.connector, env) as typeof a.connector;
  return engine().execute(
    { baseUrl: c.baseUrl, authType: c.authType, authConfig: c.authConfig, headers: c.headers, errorWhen: c.config?.errorWhen },
    interpolateDeep(tool(name).endpointMapping, env) as Tool['endpointMapping'],
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown> = {}) => execute(name, ENV, params);
const sent = () => mockedAxios.mock.calls[0][0];

const WRITES: string[] = ["judge_me_curate_review", "judge_me_reply_to_review", "judge_me_send_private_reply"];
const SWITCHED_OFF: string[] = ["judge_me_curate_review", "judge_me_reply_to_review", "judge_me_send_private_reply"];
const READ_POSTS: string[] = [];

describe('judge-me adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed under intl/e-commerce with its own icon', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('judge-me');
    expect(a.region).toBe('intl');
    expect(a.icon).toBe('judge-me');
    expect(a.category).toBe('e-commerce');
    expect(getAdapter('judge-me')).toBeDefined();
  });

  it('sends the token in X-Api-Token and the shop domain in the query of every call', async () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Api-Token', apiKey: '{{JUDGEME_API_TOKEN}}' });
    expect(a.probe.tool).toBe('judge_me_get_shop');
    for (const t of a.tools) expect(`${t.name}:${(t.endpointMapping.queryParams ?? {}).shop_domain}`).toBe(`${t.name}:{{JUDGEME_SHOP_DOMAIN}}`);
    mockedAxios.mockResolvedValue({ data: { shop: {} } });
    await call('judge_me_get_shop');
    expect(sent().headers['X-Api-Token']).toBe(TOKEN);
    expect(sent().params).toEqual({ shop_domain: SHOP });
    expect(sent().url).not.toContain(TOKEN);
  });

  it('asks for credentials as secrets with a pattern that refuses pasted prefixes', () => {
    for (const [name, meta] of Object.entries(a.envVarMeta)) {
      if (meta.kind === 'credential') expect(`${name}:${meta.secret}`).toBe(`${name}:true`);
      expect(meta.pattern).toBeDefined();
    }
    const described = describeAdapterEnvVars(a as never);
    for (const name of a.requiredEnvVars) expect(described.find((d) => d.name === name)).toBeDefined();
    const dom = new RegExp(a.envVarMeta.JUDGEME_SHOP_DOMAIN.pattern!);
    expect(dom.test(SHOP)).toBe(true);
    for (const bad of [`https://${SHOP}`, `${SHOP}/`, 'my store']) expect(dom.test(bad)).toBe(false);
    const tok = new RegExp(a.envVarMeta.JUDGEME_API_TOKEN.pattern!);
    expect(tok.test(TOKEN)).toBe(true);
    for (const bad of ['short', `${TOKEN} `]) expect(tok.test(bad)).toBe(false);
  });

  it('prefixes every tool with judge_me_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^judge_me_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    expect(mine.has(a.probe.tool)).toBe(true);
  });

  it('marks reads read-only, every write as a write with a confirmation, and installs the risky ones switched off', () => {
    for (const t of a.tools) {
      const read = t.endpointMapping.method === 'GET' || READ_POSTS.includes(t.name);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${read}`);
    }
    expect(a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const name of WRITES) expect(`${name}:${/confirm|wait for a yes/i.test(tool(name).description)}`).toBe(`${name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
    expect(annotationsOf(tool(a.probe.tool)).readOnlyHint).toBe(true);
  });

  it('URL-encodes path parameters, so an id cannot reach another route', () => {
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bjudge_me_[a-z0-9_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bjudge_me_[a-z0-9_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(3);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Judge.me\n')).toBe(true);
    expect(a.instructions).toContain('Out of scope');
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  // [tool, args, method, url]
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["judge_me_get_shop", {}, "GET", `${BASE}/shops/info`],
    ["judge_me_list_reviews", {}, "GET", `${BASE}/reviews`],
    ["judge_me_count_reviews", {}, "GET", `${BASE}/reviews/count`],
    ["judge_me_get_review", {"review_id": 42}, "GET", `${BASE}/reviews/42`],
    ["judge_me_get_reviewer", {"email": "a@example.com"}, "GET", `${BASE}/reviewers/-1`],
    ["judge_me_get_product", {"handle": "blue-shirt"}, "GET", `${BASE}/products/-1`],
    ["judge_me_get_product_rating", {"handle": "blue-shirt"}, "GET", `${BASE}/widgets/preview_badge`],
    ["judge_me_get_product_reviews_widget", {"handle": "blue-shirt"}, "GET", `${BASE}/widgets/product_review`],
    ["judge_me_get_store_rating", {}, "GET", `${BASE}/widgets/all_reviews_rating`],
    ["judge_me_get_store_review_count", {}, "GET", `${BASE}/widgets/all_reviews_count`],
    ["judge_me_get_shop_reviews_rating", {}, "GET", `${BASE}/widgets/shop_reviews_rating`],
    ["judge_me_get_settings", {"setting_keys": ["widget_star_color"]}, "GET", `${BASE}/settings`],
    ["judge_me_list_webhooks", {}, "GET", `${BASE}/webhooks`],
    ["judge_me_curate_review", {"review_id": 42, "curated": "ok"}, "PUT", `${BASE}/reviews/42`],
    ["judge_me_reply_to_review", {"review_id": 42, "content": "Thanks"}, "POST", `${BASE}/replies`],
    ["judge_me_send_private_reply", {"review_id": 42, "email_subject": "S", "email_body": "B"}, "POST", `${BASE}/private_replies`],
  ];

  it('lists every tool in the URL table', () => {
    expect([...new Set(table.map(([name]) => name))].sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s %s', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent().method.toUpperCase()).toBe(method);
    expect(sent().url).toBe(url);
  });

  it('pages reviews 20 at a time and filters by Judge.me product id and rating', async () => {
    mockedAxios.mockResolvedValue({ data: { reviews: [] } });
    await call('judge_me_list_reviews', { product_id: 7, rating: 1 });
    expect(sent().params).toEqual({ shop_domain: SHOP, page: 1, per_page: 20, product_id: 7, rating: 1 });
  });

  it('asks for settings with repeated setting_keys[]', async () => {
    mockedAxios.mockResolvedValue({ data: { settings: {} } });
    await call('judge_me_get_settings', { setting_keys: ['widget_primary_color', 'widget_star_color'] });
    expect(sent().params).toEqual({ shop_domain: SHOP, 'setting_keys[]': ['widget_primary_color', 'widget_star_color'] });
  });

  it('replies with the nested reply object and curates with curated/hidden only', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('judge_me_reply_to_review', { review_id: 42, content: 'Thanks!' });
    expect(sent().data).toEqual({ review_id: 42, reply: { content: 'Thanks!' }, send_reply_email: true });
    mockedAxios.mockClear();
    await call('judge_me_curate_review', { review_id: 42, curated: 'spam' });
    expect(sent().data).toEqual({ curated: 'spam' });
  });

  it('offers no review creation, deletion or shop uninstall', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(`${t.endpointMapping.method} ${t.endpointMapping.path}`).not.toBe('POST /reviews');
      expect(t.endpointMapping.path).not.toBe('/shops');
    }
  });
});

const LIVE = process.env.RUN_JUDGEME_LIVE === '1' && process.env.JUDGEME_SHOP_DOMAIN && process.env.JUDGEME_API_TOKEN;
const live = LIVE ? describe : describe.skip;

live('judge-me adapter: live API (reads only)', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const env = () => ({ JUDGEME_SHOP_DOMAIN: process.env.JUDGEME_SHOP_DOMAIN as string, JUDGEME_API_TOKEN: process.env.JUDGEME_API_TOKEN as string });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env(), params);

  it('reads the shop, reviews, counts, ratings and settings', async () => {
    expect((await run('judge_me_get_shop')).shop).toBeDefined();
    expect(Array.isArray((await run('judge_me_list_reviews', { per_page: 3 })).reviews)).toBe(true);
    expect(typeof (await run('judge_me_count_reviews')).count).toBe('number');
    expect(await run('judge_me_get_store_rating')).toHaveProperty('all_reviews_rating');
    expect((await run('judge_me_get_settings', { setting_keys: ['widget_star_color'] })).settings).toBeDefined();
  }, 60_000);

  it('an unknown review id is a 404', async () => {
    await expect(run('judge_me_get_review', { review_id: 1 })).rejects.toMatchObject({ response: { status: 404 } });
  }, 30_000);
});
