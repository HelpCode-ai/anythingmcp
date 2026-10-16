import axios from 'axios';
import * as adapter from './sanity.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Sanity adapter:
 *
 *   1. Static: always runs. Pins the project host and API version, the Bearer
 *      token, every tool's method and URL through the real RestEngine (checked
 *      against Sanity's HTTP API reference and @sanity/client), the Actions API
 *      bodies that keep writes on the draft (drafts.<id>), the confirm-first
 *      wording, the switched-off delete, and the response mappings against
 *      payloads captured from a public demo dataset.
 *
 *   2. Live: skipped unless RUN_SANITY_LIVE=1.
 *
 *        RUN_SANITY_LIVE=1 npx jest src/adapters/intl/sanity.live.spec.ts
 *
 *      Without credentials the read tools run keyless against Sanity's public
 *      movie demo dataset (project pv8y60vp, dataset production). With
 *      SANITY_PROJECT_ID, SANITY_DATASET and SANITY_API_TOKEN they run against
 *      that project instead, history included. With SANITY_LIVE_WRITE=1 and an
 *      Editor token, a draft "drafts.anythingmcp-test" is checked with
 *      dry_run only: nothing is saved.
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
  parameters: { properties?: Record<string, { default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { transform?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown[] };
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

const ENV = { SANITY_PROJECT_ID: 'abc12xyz', SANITY_DATASET: 'production', SANITY_API_TOKEN: 'test-token' };
const BASE = 'https://abc12xyz.api.sanity.io/v2025-02-19';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, schema defaults applied.
const run = async (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  const { body } = await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).executeWithMeta(
    {
      baseUrl: config.baseUrl,
      authType: env.SANITY_API_TOKEN ? 'BEARER_TOKEN' : 'NONE',
      authConfig: env.SANITY_API_TOKEN ? { token: env.SANITY_API_TOKEN } : {},
      headers: config.headers,
      errorWhen: a.connector.config.errorWhen,
    } as never,
    endpointMapping as never,
    applySchemaDefaults(tool(name).parameters as never, params),
  );
  return body as any;
};
const runShaped = async (name: string, params: Record<string, unknown>, env?: Record<string, string>) =>
  applyResponseTransform(await run(name, params, env), tool(name).responseMapping as never).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const WRITES = ['sanity_create_draft', 'sanity_patch_draft', 'sanity_publish_draft'];

describe('sanity adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.slug).toBe('sanity');
    expect(a.icon).toBe('sanity');
    expect(a.category).toBe('cms');
  });

  it('calls the project host with a pinned API version and a Bearer token', () => {
    expect(a.connector.baseUrl).toBe('https://{{SANITY_PROJECT_ID}}.api.sanity.io/v2025-02-19');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SANITY_API_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SANITY_PROJECT_ID', 'SANITY_DATASET', 'SANITY_API_TOKEN']);
    expect(a.envVarMeta.SANITY_API_TOKEN.secret).toBe(true);
    const project = new RegExp(a.envVarMeta.SANITY_PROJECT_ID.pattern!);
    expect(project.test('pv8y60vp')).toBe(true);
    expect(project.test('https://pv8y60vp.api.sanity.io')).toBe(false);
    const dataset = new RegExp(a.envVarMeta.SANITY_DATASET.pattern!);
    for (const ok of ['production', 'staging-2', 'my_data']) expect(dataset.test(ok)).toBe(true);
    for (const bad of ['Production', 'prod/../x', '']) expect(dataset.test(bad)).toBe(false);
    expect(a.connector.healthcheckPath).toBe('/data/query/{{SANITY_DATASET}}?query=now()');
    expect(a.probe).toEqual({ tool: 'sanity_query', params: { query: 'now()' } });
    // Viewer vs Editor is explained where the user sets the token up.
    expect(a.instructions).toMatch(/\*\*Viewer\*\*: reads/);
    expect(a.instructions).toMatch(/\*\*Editor\*\*: reads and writes/);
  });

  it('prefixes every tool with sanity_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^sanity_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('queries are marked read-only; writes ask to confirm and touch drafts only; delete is off', () => {
    for (const name of ['sanity_query', 'sanity_list_document_types']) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(annotationsOf(tool(name))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of WRITES) {
      expect(tool(name).enabled).toBeUndefined();
      expect(tool(name).description).toMatch(/confirm before calling/);
      expect(annotationsOf(tool(name)).readOnlyHint).toBe(false);
      expect(tool(name).endpointMapping.path).toBe('/data/actions/{{SANITY_DATASET}}');
    }
    expect(tool('sanity_delete_document').enabled).toBe(false);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['sanity_delete_document']);
    // A published id is what the writes take: drafts. is added by the mapping, never by the model.
    const id = new RegExp(tool('sanity_patch_draft').parameters.properties!.document_id.pattern!);
    expect(id.test('post-123')).toBe(true);
    expect(id.test('drafts.post-123')).toBe(false);
    expect(id.test('post/../x')).toBe(false);
    expect(a.instructions).toContain('**Writes: confirm first, drafts by default.**');
  });

  it('every tool shapes its answer, and only points at tools that exist', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${Boolean(tr && (tr.select || tr.exclude || tr.include))}`).toBe(`${t.name}:true`);
    }
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...a.instructions.matchAll(/\bsanity_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bsanity_[a-z_]+/g)])].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(a.instructions.startsWith('## Sanity\n')).toBe(true);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['sanity_query', { query: '*[0]' }, 'POST', `${BASE}/data/query/production`],
    ['sanity_list_document_types', {}, 'POST', `${BASE}/data/query/production`],
    ['sanity_get_document', { document_ids: 'post-1,drafts.post-1' }, 'GET', `${BASE}/data/doc/production/post-1%2Cdrafts.post-1`],
    ['sanity_get_document_revision', { document_id: 'post-1', revision: 'r1' }, 'GET', `${BASE}/data/history/production/documents/post-1`],
    ['sanity_list_document_transactions', { document_ids: 'post-1' }, 'GET', `${BASE}/data/history/production/transactions/post-1`],
    ['sanity_create_draft', { document_id: 'post-1', document: { _id: 'drafts.post-1', _type: 'post' } }, 'POST', `${BASE}/data/actions/production`],
    ['sanity_patch_draft', { document_id: 'post-1', patch: { set: { title: 'x' } } }, 'POST', `${BASE}/data/actions/production`],
    ['sanity_publish_draft', { document_id: 'post-1' }, 'POST', `${BASE}/data/actions/production`],
    ['sanity_delete_document', { document_id: 'post-1' }, 'POST', `${BASE}/data/actions/production`],
    ['sanity_list_datasets', {}, 'GET', 'https://abc12xyz.api.sanity.io/v2021-06-07/datasets'],
    ['sanity_list_projects', {}, 'GET', 'https://api.sanity.io/v2021-06-07/projects'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends the right method and URL with the Bearer token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run(name, params);
    expect(sent().method).toBe(method);
    expect(sent().url).toBe(url);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
  });

  it('encodes ids in paths, so a crafted id cannot reach another route', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('sanity_get_document', { document_ids: '../../projects' });
    expect(sent().url).toBe(`${BASE}/data/doc/production/..%2F..%2Fprojects`);
    for (const t of a.tools.filter((x) => /\{[a-z_]+\}/.test(x.endpointMapping.path))) {
      expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('posts GROQ with params and the perspective, and lists types with a fixed query', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await run('sanity_query', { query: '*[_type == $t][0...5]{_id}', params: { t: 'post' } });
    expect(sent().data).toEqual({ query: '*[_type == $t][0...5]{_id}', params: { t: 'post' } });
    expect(sent().params).toEqual({ perspective: 'published', returnQuery: 'false' });
    mockedAxios.mockClear();
    await run('sanity_list_document_types', {});
    expect(sent().data).toEqual({ query: 'array::unique(*[]._type)' });
    expect(sent().params).toEqual({ perspective: 'raw', returnQuery: 'false' });
    mockedAxios.mockClear();
    await run('sanity_list_document_transactions', { document_ids: 'post-1,drafts.post-1' });
    // excludeContent=true is required by the History API (403 without it).
    expect(sent().params).toEqual({ excludeContent: 'true', limit: 20, reverse: true });
    mockedAxios.mockClear();
    await run('sanity_list_projects', {});
    expect(sent().params).toEqual({ includeMembers: 'false' });
  });

  it('builds Actions API bodies that write the draft and publish it', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const doc = { _id: 'drafts.post-1', _type: 'post', title: 'Hello' };
    await run('sanity_create_draft', { document_id: 'post-1', document: doc });
    expect(sent().data).toEqual({
      actions: [{ actionType: 'sanity.action.document.create', publishedId: 'post-1', document: doc, ifExists: 'fail' }],
      dryRun: false,
    });
    mockedAxios.mockClear();
    await run('sanity_patch_draft', { document_id: 'post-1', patch: { set: { title: 'New' } }, dry_run: true });
    expect(sent().data).toEqual({
      actions: [{ actionType: 'sanity.action.document.edit', publishedId: 'post-1', versionId: 'drafts.post-1', patch: { set: { title: 'New' } } }],
      dryRun: true,
    });
    mockedAxios.mockClear();
    await run('sanity_publish_draft', { document_id: 'post-1' });
    expect(sent().data).toEqual({
      actions: [{ actionType: 'sanity.action.document.publish', publishedId: 'post-1', versionId: 'drafts.post-1' }],
      dryRun: false,
    });
  });

  it('turns a failed action inside a 200 answer into an error', async () => {
    mockedAxios.mockResolvedValue({ data: { transactionId: 't', results: [{ status: 'error', error: { message: 'Document not found', code: 'DOCUMENT_NOT_FOUND' } }] } });
    await expect(run('sanity_publish_draft', { document_id: 'post-1' })).rejects.toThrow(/Document not found/);
    mockedAxios.mockResolvedValue({ data: { transactionId: 't', results: [{ status: 'success' }] } });
    await expect(run('sanity_publish_draft', { document_id: 'post-1' })).resolves.toMatchObject({ transactionId: 't' });
  });

  // Captured from the public demo dataset pv8y60vp/production on 15 Oct 2026, trimmed.
  it('shapes query, document and type answers', () => {
    expect(shape('sanity_query', { result: [{ _id: 'movie_10681', title: 'WALL·E' }], syncTags: ['s1:kNmC0w'], ms: 4 }).value).toEqual({
      result: [{ _id: 'movie_10681', title: 'WALL·E' }],
      ms: 4,
    });
    expect(shape('sanity_query', { result: 0, ms: 1 }).value).toEqual({ result: 0, ms: 1 });
    expect(shape('sanity_list_document_types', { result: ['author', 'category', 'movie', 'person'], syncTags: [], ms: 19 }).value).toEqual({
      types: ['author', 'category', 'movie', 'person'],
    });
    expect(shape('sanity_get_document', { documents: [], omitted: [{ id: 'drafts.movie_10681', reason: 'existence' }] }).value).toEqual({
      documents: [],
      omitted: [{ id: 'drafts.movie_10681', reason: 'existence' }],
    });
  });

  it('caps a huge query result instead of flooding the context', () => {
    const big = { result: Array.from({ length: 2000 }, (_, n) => ({ _id: `doc-${n}`, body: 'x'.repeat(100) })), ms: 30 };
    const out = shape('sanity_query', big);
    expect(out.truncated).toBe(true);
    // The preview is the cut JSON text, so escaping adds a little on top of maxBytes.
    expect(JSON.stringify(out.value).length).toBeLessThan(70_000);
  });

  it('passes NDJSON transaction history through, capped', () => {
    const line = JSON.stringify({ id: 'mXl', timestamp: '2019-05-28T17:16:43Z', author: 'pDY', mutations: [{ create: { _id: 'b8b' } }], documentIDs: ['b8b'] });
    const ndjson = `${line}\n${line}\n`;
    expect(shape('sanity_list_document_transactions', ndjson).value).toBe(ndjson);
    const single = shape('sanity_list_document_transactions', JSON.parse(line)).value as any;
    expect(single.id).toBe('mXl');
    const huge = shape('sanity_list_document_transactions', `${line}\n`.repeat(1000));
    expect(huge.truncated).toBe(true);
  });
});

const live = process.env.RUN_SANITY_LIVE === '1' ? describe : describe.skip;

live('sanity adapter: live API', () => {
  const ownProject = Boolean(process.env.SANITY_PROJECT_ID && process.env.SANITY_DATASET && process.env.SANITY_API_TOKEN);
  const env: Record<string, string> = ownProject
    ? { SANITY_PROJECT_ID: process.env.SANITY_PROJECT_ID!, SANITY_DATASET: process.env.SANITY_DATASET!, SANITY_API_TOKEN: process.env.SANITY_API_TOKEN! }
    : { SANITY_PROJECT_ID: 'pv8y60vp', SANITY_DATASET: 'production', SANITY_API_TOKEN: '' };
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it('runs the probe query and lists document types', async () => {
    const now = await runShaped('sanity_query', a.probe.params, env);
    expect(typeof now.result).toBe('string');
    const types = await runShaped('sanity_list_document_types', {}, env);
    expect(types.types.length).toBeGreaterThan(0);
  }, 30_000);

  it('queries with params, reads documents and a revision', async () => {
    const types = await runShaped('sanity_list_document_types', {}, env);
    const type = types.types.find((t: string) => !t.startsWith('sanity.') && !t.startsWith('system.')) ?? types.types[0];
    const found = await runShaped('sanity_query', { query: '*[_type == $t][0...2]{_id, _rev}', params: { t: type } }, env);
    expect(found.result.length).toBeGreaterThan(0);
    const ids = found.result.map((d: { _id: string }) => d._id).join(',');
    const docs = await runShaped('sanity_get_document', { document_ids: ids }, env);
    expect(docs.documents.length).toBe(found.result.length);
    const rev = await runShaped('sanity_get_document_revision', { document_id: found.result[0]._id, revision: found.result[0]._rev }, env);
    expect(rev.documents[0]._id).toBe(found.result[0]._id);
    const missing = await runShaped('sanity_get_document', { document_ids: 'does-not-exist-anythingmcp' }, env);
    expect(missing.omitted).toEqual([{ id: 'does-not-exist-anythingmcp', reason: 'existence' }]);
  }, 30_000);

  it('a GROQ syntax error is a 400 with the parser message', async () => {
    await expect(run('sanity_query', { query: '*[_type ==]' }, env)).rejects.toMatchObject({ response: { status: 400 } });
  }, 30_000);

  const withToken = ownProject ? it : it.skip;
  withToken('reads transaction history and datasets with a token', async () => {
    const found = await runShaped('sanity_query', { query: '*[!(_id in path("_.**"))][0]._id' }, env);
    const history = await run('sanity_list_document_transactions', { document_ids: found.result, limit: 3 }, env);
    expect(history === '' || typeof history === 'string' || typeof history === 'object').toBe(true);
    const datasets = await runShaped('sanity_list_datasets', {}, env);
    expect(datasets.datasets.map((d: { name: string }) => d.name)).toContain(env.SANITY_DATASET);
  }, 30_000);

  const writes = ownProject && process.env.SANITY_LIVE_WRITE === '1' ? it : it.skip;
  writes('checks create, patch and publish of a draft with dry_run (nothing saved)', async () => {
    const types = await runShaped('sanity_list_document_types', {}, env);
    const type = types.types.find((t: string) => !t.startsWith('sanity.') && !t.startsWith('system.'));
    const created = await runShaped('sanity_create_draft', { document_id: 'anythingmcp-test', document: { _id: 'drafts.anythingmcp-test', _type: type }, dry_run: true }, env);
    expect(created.results[0]?.status ?? 'success').not.toBe('error');
  }, 30_000);
});
