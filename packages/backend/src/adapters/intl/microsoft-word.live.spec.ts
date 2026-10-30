import axios from 'axios';
import * as adapter from './microsoft-word.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Word (Microsoft Graph drive items, learn.microsoft.com/graph/api/resources/driveitem):
 * documents are addressed as /drives/{drive_id}/items/{item_id} so OneDrive and
 * SharePoint work alike; content comes back as a file (original or ?format=pdf),
 * new documents are copies of a template.
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with OneDrive and
 *      Excel, every Graph URL and body, the binary downloads, the Microsoft
 *      Search body restricted to Word files, and the tools switched off.
 *   2. Live (read-only): skipped unless RUN_MICROSOFT_WORD_LIVE=1 and
 *      MS_GRAPH_ACCESS_TOKEN (a delegated Graph token with Files.Read, e.g. from
 *      Graph Explorer) are set:
 *
 *        RUN_MICROSOFT_WORD_LIVE=1 MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-word
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
  parameters: { properties?: Record<string, { default?: unknown; enum?: unknown[] }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: { binary?: { maxBytes?: number }; transform?: unknown };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const P = 'microsoft_word_';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === P + name);
  if (!t) throw new Error(`missing tool ${P}${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
  return out;
};

const BASE = 'https://graph.microsoft.com/v1.0';
const D = 'b!s8RqPCGh0ESQS2EYnKM0IKS3';
const I = '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K';
const ITEM = `/drives/${D}/items/${I}`;
const call = (name: string, params: Record<string, unknown>) =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: { ...a.connector.authConfig }, headers: { ...a.connector.headers } },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  );
const sent = () => mockedAxios.mock.calls[0][0];

describe('microsoft-word adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('signs in against the configured tenant with the shared Microsoft variables and asks for a refresh token', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Files.ReadWrite',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*Files\.Read\.All/);
  });

  it('probes with /me/drive, which needs no arguments', () => {
    expect(a.probe.tool).toBe(`${P}get_my_drive`);
    expect(tool('get_my_drive').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/drive');
  });

  it('prefixes every tool, shares no name with another adapter, and every declared parameter reaches the request', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
    for (const t of a.tools) {
      expect(t.name).toMatch(/^microsoft_word_[a-z_]+$/);
      const u = used(t);
      const props = Object.keys(t.parameters.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters.required).toContain(p);
    }
  });

  it('percent-encodes ids in the path, but not OneDrive paths, whose slashes must stay', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (p.includes('{path}')) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:undefined`);
      else if (/\{\w+\}/.test(p)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs the sharing link and delete switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([`${P}create_sharing_link`, `${P}delete_document`]);
    expect(a.instructions).toContain(`**Switched off at install**: \`${P}create_sharing_link\` and \`${P}delete_document\`;`);
    expect(annotationsOf(tool('delete_document')).destructiveHint).toBe(true);
  });

  it('marks reads (the POST search included) read-only, and rename, move and check-in as non-destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name.slice(P.length));
    expect(readOnly.sort()).toEqual([
      'convert_to_pdf',
      'download_document',
      'download_version',
      'find_documents',
      'get_document',
      'get_document_by_path',
      'get_my_drive',
      'list_folder',
      'list_permissions',
      'list_versions',
      'search_my_documents',
    ]);
    for (const n of ['rename_document', 'move_document', 'check_out', 'check_in']) expect(annotationsOf(tool(n)).destructiveHint).toBe(false);
    expect(annotationsOf(tool('restore_version')).destructiveHint).toBe(true);
  });

  it.each([
    ['get_my_drive', {}, 'GET', '/me/drive'],
    ['search_my_documents', { query: 'offer 2026' }, 'GET', "/me/drive/root/search(q='offer%202026')"],
    ['find_documents', { query: 'offer' }, 'POST', '/search/query'],
    ['list_folder', { drive_id: D, item_id: 'root' }, 'GET', `/drives/${D}/items/root/children`],
    ['get_document', { drive_id: D, item_id: I }, 'GET', ITEM],
    ['get_document_by_path', { path: 'Documents/Offer 2026.docx' }, 'GET', '/me/drive/root:/Documents/Offer 2026.docx'],
    ['download_document', { drive_id: D, item_id: I }, 'GET', `${ITEM}/content`],
    ['convert_to_pdf', { drive_id: D, item_id: I }, 'GET', `${ITEM}/content`],
    ['list_versions', { drive_id: D, item_id: I }, 'GET', `${ITEM}/versions`],
    ['download_version', { drive_id: D, item_id: I, version_id: '3.0' }, 'GET', `${ITEM}/versions/3.0/content`],
    ['list_permissions', { drive_id: D, item_id: I }, 'GET', `${ITEM}/permissions`],
    ['copy_document', { drive_id: D, item_id: I, destination_drive_id: D, destination_folder_id: '01CD', name: 'n.docx' }, 'POST', `${ITEM}/copy`],
    ['rename_document', { drive_id: D, item_id: I, name: 'n.docx' }, 'PATCH', ITEM],
    ['move_document', { drive_id: D, item_id: I, new_parent_id: '01CD' }, 'PATCH', ITEM],
    ['restore_version', { drive_id: D, item_id: I, version_id: '3.0' }, 'POST', `${ITEM}/versions/3.0/restoreVersion`],
    ['check_out', { drive_id: D, item_id: I }, 'POST', `${ITEM}/checkout`],
    ['check_in', { drive_id: D, item_id: I, comment: 'c' }, 'POST', `${ITEM}/checkin`],
    ['create_sharing_link', { drive_id: D, item_id: I, type: 'view' }, 'POST', `${ITEM}/createLink`],
    ['delete_document', { drive_id: D, item_id: I }, 'DELETE', ITEM],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('converts with ?format=pdf and hands both downloads over as files up to 10 MB', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('convert_to_pdf', { drive_id: D, item_id: I });
    expect(sent().params).toEqual({ format: 'pdf' });
    for (const n of ['download_document', 'convert_to_pdf', 'download_version']) expect(tool(n).responseMapping?.binary?.maxBytes).toBe(10485760);
    expect(tool('download_document').endpointMapping.queryParams).toBeUndefined();
  });

  it('restricts Microsoft Search to Word files through the query template', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('find_documents', { query: 'author:"Ana Diaz"', from: 25, size: 25 });
    expect(sent().data).toEqual({
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString: 'author:"Ana Diaz"', queryTemplate: '({searchTerms}) (filetype:docx OR filetype:docm OR filetype:doc)' },
          from: 25,
          size: 25,
        },
      ],
    });
  });

  it('copies a template into a folder under a new name and refuses to overwrite by default', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('copy_document', { drive_id: D, item_id: I, destination_drive_id: 'b!2', destination_folder_id: '01CD', name: 'Offer Rossi.docx' });
    expect(sent().data).toEqual({ parentReference: { driveId: 'b!2', id: '01CD' }, name: 'Offer Rossi.docx' });
    expect(sent().params).toEqual({ '@microsoft.graph.conflictBehavior': 'fail' });
  });

  it('builds the rename, move, check-in and sharing link bodies Graph documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('move_document', { drive_id: D, item_id: I, new_parent_id: '01CD' });
    expect(sent().data).toEqual({ parentReference: { id: '01CD' } });
    mockedAxios.mockClear();
    await call('check_in', { drive_id: D, item_id: I, comment: 'Prices updated', check_in_as: 'published' });
    expect(sent().data).toEqual({ comment: 'Prices updated', checkInAs: 'published' });
    mockedAxios.mockClear();
    await call('create_sharing_link', { drive_id: D, item_id: I, type: 'view', scope: 'organization' });
    expect(sent().data).toEqual({ type: 'view', scope: 'organization' });
  });

  it('never selects the pre-authenticated download URL and strips it from write answers', () => {
    for (const t of a.tools) expect(String(t.endpointMapping.queryParams?.$select ?? '')).not.toMatch(/downloadUrl/);
    for (const n of ['rename_document', 'move_document', 'list_versions']) {
      const mapping = tool(n).responseMapping!;
      expect(validateTransform(mapping.transform as never)).toBeNull();
      const out = applyResponseTransform({ id: '01AB', '@microsoft.graph.downloadUrl': 'https://public.example/x' }, mapping as never).value;
      expect(out).toEqual({ id: '01AB' });
    }
  });

  it('documents every tool in the instructions, names only real tools, and writes no em dash', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of names) expect(`${n}:${a.instructions.includes(n)}`).toBe(`${n}:true`);
    const mentioned = [a.instructions, ...a.tools.map((t) => t.description)].flatMap((s) => [...s.matchAll(/\bmicrosoft_word_[a-z_]+/g)].map((m) => m[0]));
    for (const n of mentioned) expect(names).toContain(n);
    expect(JSON.stringify(adapter)).not.toMatch(/—/);
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = process.env.RUN_MICROSOFT_WORD_LIVE === '1' && TOKEN ? describe : describe.skip;

live('microsoft-word adapter: live Graph API (read-only)', () => {
  beforeAll(() => mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as never)));
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping,
        applySchemaDefaults(tool(name).parameters, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping as never).value);

  it('reads the drive, searches for documents and reads one document with its versions and permissions', async () => {
    const drive = await run('get_my_drive');
    expect(typeof drive.id).toBe('string');
    const root = await run('list_folder', { drive_id: drive.id, item_id: 'root', top: 5 });
    expect(Array.isArray(root.value)).toBe(true);
    const hits = await run('search_my_documents', { query: 'docx', top: 10 });
    const doc = (hits.value as Array<{ id: string; name: string; parentReference: { driveId: string } }>).find((h) => /\.docx$/i.test(h.name));
    if (!doc) return;
    const item = await run('get_document', { drive_id: doc.parentReference.driveId, item_id: doc.id });
    expect(item.id).toBe(doc.id);
    expect(Array.isArray((await run('list_versions', { drive_id: doc.parentReference.driveId, item_id: doc.id })).value)).toBe(true);
    expect(Array.isArray((await run('list_permissions', { drive_id: doc.parentReference.driveId, item_id: doc.id })).value)).toBe(true);
  }, 60_000);
});
