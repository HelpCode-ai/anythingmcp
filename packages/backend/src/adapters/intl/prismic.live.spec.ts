import axios from 'axios';
import * as adapter from './prismic.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';

/**
 * Prismic (prismic.io/docs/content-api, /migration-api-technical-reference, /asset-api-technical-reference,
 * /custom-types-api, /api-authentication; no OpenAPI file is published):
 *   - Content API https://<repo>.cdn.prismic.io/api/v2, keyless for public repositories, optional
 *     access_token query parameter for private ones; every query needs a ref from the repository endpoint.
 *   - Types, Asset and Migration APIs on their own hosts with `repository` and `Authorization: Bearer`
 *     write-token headers.
 * Live part, keyless (reads only): the public demo repository slicemachine-blank, its master ref and a
 * document search, plus 403 on the write-token hosts with a fake token:
 *   RUN_PRISMIC_LIVE=1 npx jest src/adapters/intl/prismic
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
  parameters?: { properties?: Record<string, { enum?: unknown[]; format?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string>; bodyEncoding?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings (connector variables aside).
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) if (!/^PRISMIC_/.test(p)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const PREFIX = 'prismic_';
// Built at runtime so no literal looks like a real credential.
const WRITE = ['write', 'x'.repeat(24)].join('-');
const ACCESS = ['read', 'y'.repeat(24)].join('-');
const ENV: Record<string, string> = { PRISMIC_REPOSITORY: 'demo-repo', PRISMIC_WRITE_TOKEN: WRITE };

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector and the mapping, variables passed with the arguments.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl: a.connector.baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, env);
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: a.connector.authType, authConfig: interpolateDeep(a.connector.authConfig, env), headers: config.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  ) as Promise<unknown>;
};
const sent = () => mockedAxios.mock.calls[0][0];

describe('prismic adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('needs only the repository; the access and write tokens are optional', () => {
    expect(a.requiredEnvVars).toEqual(['PRISMIC_REPOSITORY']);
    expect(a.optionalEnvVars).toEqual(['PRISMIC_ACCESS_TOKEN', 'PRISMIC_WRITE_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://{{PRISMIC_REPOSITORY}}.cdn.prismic.io/api/v2');
    expect(a.connector.authType).toBe('NONE');
    expect(a.envVarMeta?.PRISMIC_ACCESS_TOKEN.secret).toBe(true);
    expect(a.envVarMeta?.PRISMIC_WRITE_TOKEN.secret).toBe(true);
    const repo = new RegExp(a.envVarMeta?.PRISMIC_REPOSITORY.pattern ?? '');
    expect(repo.test('your-repo-name')).toBe(true);
    for (const bad of ['https://x.prismic.io', 'x.prismic.io', 'Repo']) expect(repo.test(bad)).toBe(false);
  });

  it('reads the repository refs and queries documents with an interpolated filter', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('prismic_get_repository', {});
    expect(sent().url).toBe('https://demo-repo.cdn.prismic.io/api/v2');
    expect(sent().params ?? {}).toEqual({});
    mockedAxios.mockClear();
    await call('prismic_get_document', { ref: 'REF1', id: 'ZMI65RQAADkECUFM' });
    expect(sent().url).toBe('https://demo-repo.cdn.prismic.io/api/v2/documents/search');
    expect(sent().params).toEqual({ ref: 'REF1', q: '[[at(document.id,"ZMI65RQAADkECUFM")]]' });
    mockedAxios.mockClear();
    await call('prismic_get_document_by_uid', { ref: 'REF1', type: 'page', uid: 'about-us', lang: 'en-us' });
    expect(sent().params).toEqual({ ref: 'REF1', q: '[[at(my.page.uid,"about-us")]]', lang: 'en-us' });
    mockedAxios.mockClear();
    await call('prismic_list_documents_by_type', { ref: 'REF1', type: 'blog_post', orderings: '[document.first_publication_date desc]', page: 2, page_size: 50 });
    expect(sent().params).toEqual({ ref: 'REF1', q: '[[at(document.type,"blog_post")]]', orderings: '[document.first_publication_date desc]', page: 2, pageSize: 50 });
  });

  it('adds access_token only when the private-API token is set', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('prismic_search_documents', { ref: 'REF1', q: '[[at(document.tags,["news"])]]' }, { ...ENV, PRISMIC_ACCESS_TOKEN: ACCESS });
    expect(sent().params).toEqual({ ref: 'REF1', q: '[[at(document.tags,["news"])]]', access_token: ACCESS });
    for (const t of a.tools.filter((x) => !x.endpointMapping.path.startsWith('https://'))) expect(`${t.name}:${t.endpointMapping.queryParams?.access_token}`).toBe(`${t.name}:\${PRISMIC_ACCESS_TOKEN}`);
  });

  it('sends the repository and Bearer write token to the Types, Asset and Migration hosts', async () => {
    const hosts = ['https://customtypes.prismic.io/', 'https://asset-api.prismic.io/', 'https://migration.prismic.io/'];
    const writeTools = a.tools.filter((t) => t.endpointMapping.path.startsWith('https://'));
    expect(writeTools.map((t) => t.name)).toEqual([
      'prismic_list_custom_types',
      'prismic_get_custom_type',
      'prismic_list_shared_slices',
      'prismic_get_shared_slice',
      'prismic_list_assets',
      'prismic_upload_asset',
      'prismic_update_asset',
      'prismic_create_document',
      'prismic_update_document',
    ]);
    for (const t of writeTools) {
      expect(hosts.some((h) => t.endpointMapping.path.startsWith(h))).toBe(true);
      expect(t.endpointMapping.headers).toEqual({ repository: '{{PRISMIC_REPOSITORY}}', Authorization: 'Bearer ${PRISMIC_WRITE_TOKEN}' });
      expect(['write token', 'Migration API', 'media library'].some((w) => t.description.includes(w))).toBe(true);
    }
    mockedAxios.mockResolvedValue({ data: {} });
    await call('prismic_get_custom_type', { type_id: 'blog_post' });
    expect(sent().url).toBe('https://customtypes.prismic.io/customtypes/blog_post');
    expect(sent().headers).toMatchObject({ repository: 'demo-repo', Authorization: `Bearer ${WRITE}` });
    mockedAxios.mockClear();
    await call('prismic_create_document', { title: 'Hello', type: 'page', uid: 'hello', lang: 'en-us', data: { title: [] } });
    expect(sent().method).toBe('POST');
    expect(sent().url).toBe('https://migration.prismic.io/documents');
    expect(sent().data).toEqual({ title: 'Hello', type: 'page', uid: 'hello', lang: 'en-us', data: { title: [] } });
    mockedAxios.mockClear();
    await call('prismic_update_document', { id: 'ZMI65RQAADkECUFM', uid: 'hello', data: { title: [] }, tags: ['news'] });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://migration.prismic.io/documents/ZMI65RQAADkECUFM/');
    mockedAxios.mockClear();
    await call('prismic_update_asset', { asset_id: 'A1', alt: 'Red bike' });
    expect(sent().method).toBe('PATCH');
    expect(sent().data).toEqual({ alt: 'Red bike' });
    mockedAxios.mockClear();
    await call('prismic_list_assets', { asset_type: 'image', keyword: 'bike', limit: 50 });
    expect(sent().params).toEqual({ assetType: 'image', keyword: 'bike', limit: 50 });
  });

  it('uploads media from a URL as a multipart file part', () => {
    const m = tool('prismic_upload_asset').endpointMapping;
    expect(m.bodyEncoding).toBe('form-data');
    expect(m.bodyMapping).toEqual({ file: { __file: '$file_url' }, alt: '$alt', credits: '$credits', notes: '$notes' });
    expect(tool('prismic_upload_asset').parameters?.properties?.file_url.format).toBe('uri');
  });

  it('has no delete and no tool switched off', () => {
    for (const t of a.tools) {
      expect(t.endpointMapping.method).not.toBe('DELETE');
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_PRISMIC_LIVE === '1' ? describe : describe.skip;
live('prismic adapter: live (read-only, keyless)', () => {
  const real = () => mockedAxios.__actual;
  it('reads the master ref and searches documents of a public repository', async () => {
    const repo = await real().get('https://slicemachine-blank.cdn.prismic.io/api/v2');
    expect(repo.status).toBe(200);
    const master = (repo.data.refs as Array<{ ref: string; isMasterRef?: boolean }>).find((r) => r.isMasterRef);
    expect(master?.ref).toBeTruthy();
    const res = await real().get('https://slicemachine-blank.cdn.prismic.io/api/v2/documents/search', { params: { ref: master?.ref, pageSize: 1 } });
    expect(res.status).toBe(200);
    expect(typeof res.data.total_results_size).toBe('number');
  }, 30_000);

  it('answers 403, not 404, on the write-token hosts with a fake token', async () => {
    for (const url of ['https://customtypes.prismic.io/customtypes', 'https://asset-api.prismic.io/assets']) {
      const res = await real().get(url, { headers: { repository: 'slicemachine-blank', Authorization: `Bearer ${WRITE}` }, validateStatus: () => true });
      expect(`${url}:${res.status}`).toBe(`${url}:403`);
    }
  }, 30_000);
});
