import axios from 'axios';
import * as adapter from './diffbot.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Diffbot APIs (www.diffbot.com/docs, pages generated from Diffbot's OpenAPI
 * definitions: account, extract/analyze, article, product, discussion, image,
 * video, dql/get, enhance/get, natural-language/process-text, web-search/get),
 * checked on 30 Oct 2026 against those pages, the official TypeScript client
 * (github.com/diffbot/diffbot-typescript: constants.ts, extract.ts, kg.ts,
 * nlp.ts, which posts the NL body as an array) and the official MCP server
 * (github.com/diffbot/diffbot-mcp: tools/extract.py sends mode=llm for
 * markdown and reads errorCode from a 200 body).
 *
 *   1. Static: always runs. Token as ?token= on every host (Web Search also as
 *      a Bearer header), every tool's URL, query and body through the real
 *      RestEngine, parameter wiring, the errorWhen rules, PAID labels.
 *   2. Live: skipped unless RUN_DIFFBOT_LIVE=1. Without a token it checks that
 *      a wrong token gets 401 on the account, extract, DQL and Enhance routes.
 *      With DIFFBOT_TOKEN it reads the account only (free):
 *
 *        RUN_DIFFBOT_LIVE=1 DIFFBOT_TOKEN=... npx jest src/adapters/intl/diffbot.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; bodyTemplate?: string };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string; config: { errorWhen: Array<Record<string, unknown>> } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings or the body template.
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  walk(m.bodyTemplate ?? '');
  return out;
};

const API = 'https://api.diffbot.com';
// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = ['d1', 'f'.repeat(15), '0'.repeat(15)].join('');
const ENV: Record<string, string> = { DIFFBOT_TOKEN: FAKE_TOKEN };

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
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

describe('diffbot adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the token as ?token= and checks it on the account API', () => {
    expect(a.slug).toBe('diffbot');
    expect(a.icon).toBe('diffbot');
    expect(a.connector.baseUrl).toBe(API);
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ token: '{{DIFFBOT_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/v4/account');
    expect(a.requiredEnvVars).toEqual(['DIFFBOT_TOKEN']);
    const [meta] = describeAdapterEnvVars(a as never);
    expect(meta).toMatchObject({ name: 'DIFFBOT_TOKEN', kind: 'credential', secret: true, required: true });
    const re = new RegExp(a.envVarMeta.DIFFBOT_TOKEN.pattern!);
    expect(re.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `token=${FAKE_TOKEN}`, `${FAKE_TOKEN} `, 'short']) expect(re.test(bad)).toBe(false);
    for (const status of ['401', '429']) expect(a.verifyHints[status]).toBeTruthy();
  });

  it('turns an errorCode inside a 200 body into a failed call, auth codes first', () => {
    const rules = a.connector.config.errorWhen;
    expect(rules[0]).toEqual({ path: 'errorCode', in: [401, 403], messagePath: 'error', status: 401 });
    expect(rules[rules.length - 1]).toEqual({ path: 'errorCode', messagePath: 'error', status: 400 });
    for (const r of rules) expect(r.path).toBe('errorCode');
  });

  it('probes with the free account read and removes the token from its answer', () => {
    expect(a.probe).toEqual({ tool: 'diffbot_get_account' });
    expect(tool(a.probe.tool).parameters.required ?? []).toEqual([]);
    const out = shape('diffbot_get_account', { name: 'Diffy', plan: 'free', planCredits: 10000, token: 'secret', childTokens: ['x'], usage: [{ date: '2026-10-29', credits: 3 }] }).value as any;
    expect(out.token).toBeUndefined();
    expect(out.childTokens).toBeUndefined();
    expect(out.usage).toEqual([{ date: '2026-10-29', credits: 3 }]);
  });

  it('prefixes every tool, wires every declared parameter and documents each one', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^diffbot_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      if (t.responseMapping?.transform) expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  it('is read-only (the NL POST too), switches nothing off and labels every paid call', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([]);
    const paid = a.tools.filter((t) => t.description.startsWith('PAID')).map((t) => t.name).sort();
    expect(paid).toEqual(a.tools.map((t) => t.name).filter((n) => n !== 'diffbot_get_account').sort());
    expect(tool('diffbot_search_kg').description).toMatch(/25 credits per entity/);
    expect(tool('diffbot_enhance').description).toMatch(/25 credits per match/);
  });

  it('names every tool in the instructions and writes no em dash', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const name of names) expect(`${name}:${a.instructions.includes(`\`${name}\``)}`).toBe(`${name}:true`);
    const mentioned = [...a.instructions.matchAll(/\bdiffbot_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdiffbot_[a-z_]+/g)])].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions).toContain('https://mcp.diffbot.com/mcp');
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['diffbot_get_account', {}, 'GET', `${API}/v4/account`],
    ['diffbot_analyze', { url: 'https://example.com' }, 'GET', `${API}/v3/analyze`],
    ['diffbot_extract_article', { url: 'https://example.com' }, 'GET', `${API}/v3/article`],
    ['diffbot_extract_product', { url: 'https://example.com' }, 'GET', `${API}/v3/product`],
    ['diffbot_extract_discussion', { url: 'https://example.com' }, 'GET', `${API}/v3/discussion`],
    ['diffbot_extract_image', { url: 'https://example.com' }, 'GET', `${API}/v3/image`],
    ['diffbot_extract_video', { url: 'https://example.com' }, 'GET', `${API}/v3/video`],
    ['diffbot_search_kg', { query: 'type:Organization name:"Diffbot"' }, 'GET', 'https://kg.diffbot.com/kg/v3/dql'],
    ['diffbot_enhance', { type: 'Organization', name: 'Diffbot' }, 'GET', 'https://kg.diffbot.com/kg/v3/enhance'],
    ['diffbot_analyze_text', { content: 'Diffbot is based in Menlo Park.' }, 'POST', 'https://nl.diffbot.com/v1/'],
    ['diffbot_search_web', { text: 'diffbot' }, 'GET', 'https://llm.diffbot.com/api/v1/web_search'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the documented host with ?token=', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.params.token).toBe(FAKE_TOKEN);
  });

  it('maps extract options to the documented camelCase query names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('diffbot_analyze', { url: 'https://example.com', mode: 'llm', use_proxy: 'default', discussion: false });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, url: 'https://example.com', mode: 'llm', useProxy: 'default', discussion: false });
    mockedAxios.mockClear();
    await call('diffbot_extract_article', { url: 'https://example.com', max_tags: 5, tag_confidence: 0.7, natural_language: 'summary,entities', summary_num_sentences: 2, paging: true });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, url: 'https://example.com', maxTags: 5, tagConfidence: 0.7, naturalLanguage: 'summary,entities', summaryNumSentences: 2, paging: true });
    mockedAxios.mockClear();
    await call('diffbot_extract_discussion', { url: 'https://example.com', paging: true, max_pages: 'all' });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, url: 'https://example.com', paging: true, maxPages: 'all' });
  });

  it('queries the Knowledge Graph with type=query, a small default size and filters', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [] } });
    await call('diffbot_search_kg', { query: 'type:Organization name:"Diffbot"', filter: 'name;homepageUri', filter_exclude: 'description' });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, type: 'query', query: 'type:Organization name:"Diffbot"', size: 5, filter: 'name;homepageUri', filterExclude: 'description' });
    mockedAxios.mockClear();
    await call('diffbot_enhance', { type: 'Person', name: 'Mike Tung', employer: 'Diffbot', refresh: true });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, type: 'Person', name: 'Mike Tung', employer: 'Diffbot', refresh: true });
  });

  it('posts Natural Language text as a one-element array with escaped content', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    await call('diffbot_analyze_text', { content: 'He said "hi"\nand left.' });
    expect(sent().params).toEqual({ token: FAKE_TOKEN, fields: 'entities,sentiment' });
    expect(sent().data).toEqual([{ content: 'He said "hi"\nand left.', lang: 'auto', format: 'plain text' }]);
  });

  it('sends Web Search the token as a Bearer header too', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('diffbot_search_web', { text: 'knowledge graph site:diffbot.com', size: 3, max_tokens: 2000 });
    expect(sent().headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(sent().params).toEqual({ token: FAKE_TOKEN, text: 'knowledge graph site:diffbot.com', size: 3, maxTokens: 2000 });
  });

  it('removes page HTML from extraction answers', () => {
    const out = shape('diffbot_extract_article', { request: { pageUrl: 'https://example.com' }, objects: [{ type: 'article', title: 'T', text: 'body', html: '<p>body</p>' }] }).value;
    expect(out).toEqual({ request: { pageUrl: 'https://example.com' }, objects: [{ type: 'article', title: 'T', text: 'body' }] });
  });
});

const live = process.env.RUN_DIFFBOT_LIVE === '1' ? describe : describe.skip;
live('diffbot adapter: live (GET, free reads only)', () => {
  const realToken = process.env.DIFFBOT_TOKEN;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['diffbot_get_account', {}],
    ['diffbot_analyze', { url: 'https://example.com' }],
    ['diffbot_search_kg', { query: 'type:Organization name:"Diffbot"', size: 1 }],
    ['diffbot_enhance', { type: 'Organization', name: 'Diffbot' }],
  ])('%s reaches Diffbot and a wrong token is refused (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (realToken ? it : it.skip)('reads the account (free)', async () => {
    const account = shape('diffbot_get_account', await call('diffbot_get_account', { days: 7 }, { DIFFBOT_TOKEN: realToken! })).value as any;
    expect(typeof account.plan).toBe('string');
    expect(account.token).toBeUndefined();
  }, 30000);
});
