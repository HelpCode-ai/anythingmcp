import axios from 'axios';
import * as adapter from './canva.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { describeAdapterEnvVars, needsBrowserAuthorization } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Canva adapter:
 *
 *   1. Static: always runs. Pins the OAuth settings (authorization code with
 *      PKCE, which the engine always sends; HTTP Basic at the token endpoint;
 *      the scope list), every tool's method and URL, the design, export,
 *      folder, asset and comment bodies, and which tools are read-only or
 *      switched off.
 *
 *   2. Live: skipped unless CANVA_ACCESS_TOKEN is set, an access token from
 *      an authorization of a Canva app with the scopes in the instructions
 *      (it lasts about four hours):
 *
 *        CANVA_ACCESS_TOKEN=... npx jest src/adapters/intl/canva.live.spec.ts
 *
 *      Reads the user, profile, capabilities, designs with their export
 *      formats, the top-level Projects items and a folder, and brand
 *      templates with their dataset when the plan has them.
 *
 *      CANVA_LIVE_WRITE=1 creates a folder "AnythingMCP test", renames it,
 *      creates a document design and moves it into the folder, exports it to
 *      PDF and waits for the download URL, comments on it and replies,
 *      uploads an image from CANVA_TEST_IMAGE_URL (default: a small public
 *      PNG), renames and deletes that asset, and deletes the folder in
 *      `finally`, which moves the test design to the Trash.
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
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

const BASE = 'https://api.canva.com/rest/v1';
// The OAuth access token is handed to the engine as a bearer token, which is
// what OAUTH2 auth puts on the request too.
const execute = (name: string, token: string, params: Record<string, unknown>) =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: a.connector.headers },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
const call = (name: string, params: Record<string, unknown>) => execute(name, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];
const OFF = ['canva_delete_asset', 'canva_delete_folder'];
const SCOPES = [
  'profile:read', 'design:meta:read', 'design:content:read', 'design:content:write', 'folder:read', 'folder:write',
  'asset:read', 'asset:write', 'brandtemplate:meta:read', 'brandtemplate:content:read', 'comment:read', 'comment:write',
];

describe('canva adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.prerequisites).toMatch(/multi-factor/);
  });

  it('signs in through Canva OAuth with HTTP Basic at the token endpoint and the documented scopes', () => {
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{CANVA_CLIENT_ID}}',
      clientSecret: '{{CANVA_CLIENT_SECRET}}',
      authorizationUrl: 'https://www.canva.com/api/oauth/authorize',
      tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: SCOPES.join(' '),
    });
    expect(needsBrowserAuthorization(a as never)).toBe(true);
    expect(a.requiredEnvVars).toEqual(['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET']);
    expect(describeAdapterEnvVars(a as never).find((d) => d.name === 'CANVA_CLIENT_SECRET')!.secret).toBe(true);
    expect(a.appRegistrationUrl).toBe('https://www.canva.com/developers/apps');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    // Canva refuses localhost redirect URLs; the instructions say so.
    expect(a.instructions).toContain('127.0.0.1');
    for (const scope of SCOPES) expect(a.instructions).toContain(`\`${scope}\``);
  });

  it('probes with the user id, which needs no scope', () => {
    expect(a.probe).toEqual({ tool: 'canva_get_me' });
    expect(a.connector.healthcheckPath).toBe('/users/me');
  });

  it('prefixes every tool with canva_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^canva_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only, installs deletions switched off and flags the preview APIs', () => {
    for (const t of a.tools) expect(`${t.name}:${annotationsOf(t).readOnlyHint === true}`).toBe(`${t.name}:${t.endpointMapping.method === 'GET'}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of OFF) expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    for (const name of ['canva_create_export', 'canva_create_design', 'canva_create_folder', 'canva_move_folder_item', 'canva_create_comment']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(false);
    }
    const preview = a.tools.filter((t) => t.description.includes('preview API')).map((t) => t.name).sort();
    expect(preview).toEqual([
      'canva_create_comment',
      'canva_get_asset_upload',
      'canva_get_comment_thread',
      'canva_list_comment_replies',
      'canva_reply_to_comment',
      'canva_upload_asset_from_url',
    ]);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bcanva_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bcanva_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['canva_get_me', {}, 'GET', '/users/me'],
    ['canva_get_profile', {}, 'GET', '/users/me/profile'],
    ['canva_get_capabilities', {}, 'GET', '/users/me/capabilities'],
    ['canva_list_designs', {}, 'GET', '/designs'],
    ['canva_get_design', { design_id: 'DAF1' }, 'GET', '/designs/DAF1'],
    ['canva_create_design', { design_type: { type: 'preset', name: 'doc' } }, 'POST', '/designs'],
    ['canva_get_design_export_formats', { design_id: 'DAF1' }, 'GET', '/designs/DAF1/export-formats'],
    ['canva_create_export', { design_id: 'DAF1', format: { type: 'pdf' } }, 'POST', '/exports'],
    ['canva_get_export', { export_id: 'job1' }, 'GET', '/exports/job1'],
    ['canva_list_folder_items', { folder_id: 'root' }, 'GET', '/folders/root/items'],
    ['canva_get_folder', { folder_id: 'FAF1' }, 'GET', '/folders/FAF1'],
    ['canva_create_folder', { name: 'X', parent_folder_id: 'root' }, 'POST', '/folders'],
    ['canva_rename_folder', { folder_id: 'FAF1', name: 'Y' }, 'PATCH', '/folders/FAF1'],
    ['canva_move_folder_item', { item_id: 'DAF1', to_folder_id: 'FAF1' }, 'POST', '/folders/move'],
    ['canva_delete_folder', { folder_id: 'FAF1' }, 'DELETE', '/folders/FAF1'],
    ['canva_get_asset', { asset_id: 'MAF1' }, 'GET', '/assets/MAF1'],
    ['canva_update_asset', { asset_id: 'MAF1', name: 'n' }, 'PATCH', '/assets/MAF1'],
    ['canva_delete_asset', { asset_id: 'MAF1' }, 'DELETE', '/assets/MAF1'],
    ['canva_upload_asset_from_url', { name: 'n', url: 'https://example.com/a.png' }, 'POST', '/url-asset-uploads'],
    ['canva_get_asset_upload', { job_id: 'job2' }, 'GET', '/url-asset-uploads/job2'],
    ['canva_list_brand_templates', {}, 'GET', '/brand-templates'],
    ['canva_get_brand_template', { brand_template_id: 'DAE1' }, 'GET', '/brand-templates/DAE1'],
    ['canva_get_brand_template_dataset', { brand_template_id: 'DAE1' }, 'GET', '/brand-templates/DAE1/dataset'],
    ['canva_create_comment', { design_id: 'DAF1', message_plaintext: 'Hi' }, 'POST', '/designs/DAF1/comments'],
    ['canva_get_comment_thread', { design_id: 'DAF1', thread_id: 'T1' }, 'GET', '/designs/DAF1/comments/T1'],
    ['canva_list_comment_replies', { design_id: 'DAF1', thread_id: 'T1' }, 'GET', '/designs/DAF1/comments/T1/replies'],
    ['canva_reply_to_comment', { design_id: 'DAF1', thread_id: 'T1', message_plaintext: 'Ok' }, 'POST', '/designs/DAF1/comments/T1/replies'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(expect.objectContaining({ method, url: `${BASE}${path}` }));
  });

  it('creates designs in the type_and_asset mode and exports with the format object as given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('canva_create_design', { design_type: { type: 'custom', width: 1080, height: 1080 }, title: 'Post' });
    expect(sent().data).toEqual({ type: 'type_and_asset', design_type: { type: 'custom', width: 1080, height: 1080 }, title: 'Post' });
    mockedAxios.mockClear();
    await call('canva_create_export', { design_id: 'DAF1', format: { type: 'png', width: 1080, pages: [1] } });
    expect(sent().data).toEqual({ design_id: 'DAF1', format: { type: 'png', width: 1080, pages: [1] } });
  });

  it('lists designs 25 at a time and folder items 50 at a time by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('canva_list_designs', { query: 'flyer', sort_by: 'modified_descending' });
    expect(sent().params).toEqual({ query: 'flyer', sort_by: 'modified_descending', limit: 25 });
    mockedAxios.mockClear();
    await call('canva_list_folder_items', { folder_id: 'uploads', item_types: 'image' });
    expect(sent().params).toEqual({ item_types: 'image', limit: 50 });
  });

  it('sends comments and asset changes with Canva\'s field names', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('canva_create_comment', { design_id: 'DAF1', message_plaintext: 'Look [u1:t1]', assignee_id: 'u1' });
    expect(sent().data).toEqual({ message_plaintext: 'Look [u1:t1]', assignee_id: 'u1' });
    mockedAxios.mockClear();
    await call('canva_update_asset', { asset_id: 'MAF1', tags: ['logo', 'blue'] });
    expect(sent().data).toEqual({ tags: ['logo', 'blue'] });
  });
});

const TOKEN = process.env.CANVA_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('canva adapter: live REST API', () => {
  const write = process.env.CANVA_LIVE_WRITE === '1';
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, TOKEN as string, params);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (read: () => Promise<any>, done: (job: any) => boolean, seconds = 90) => {
    for (let i = 0; i < seconds / 2; i++) {
      const answer = await read();
      if (done(answer.job)) return answer.job;
      await sleep(2000);
    }
    throw new Error('job did not finish in time');
  };

  it('reads the user, profile, capabilities, designs, folders and brand templates', async () => {
    const me = await run('canva_get_me');
    expect(me.team_user.user_id).toBeDefined();
    expect((await run('canva_get_profile')).profile.display_name).toBeDefined();
    const capabilities = (await run('canva_get_capabilities')).capabilities ?? [];
    expect(Array.isArray(capabilities)).toBe(true);
    const designs = await run('canva_list_designs', { limit: 3, sort_by: 'modified_descending' });
    expect(Array.isArray(designs.items)).toBe(true);
    if (designs.items.length) {
      const id = designs.items[0].id;
      expect((await run('canva_get_design', { design_id: id })).design.id).toBe(id);
      expect((await run('canva_get_design_export_formats', { design_id: id })).formats).toBeDefined();
    }
    const top = await run('canva_list_folder_items', { folder_id: 'root', limit: 10 });
    expect(Array.isArray(top.items)).toBe(true);
    const folder = top.items.find((x: { type: string }) => x.type === 'folder');
    if (folder) expect((await run('canva_get_folder', { folder_id: folder.folder.id })).folder.id).toBe(folder.folder.id);
    if (capabilities.includes('brand_template')) {
      const templates = await run('canva_list_brand_templates', { limit: 3 });
      expect(Array.isArray(templates.items)).toBe(true);
      if (templates.items.length) {
        const id = templates.items[0].id;
        expect((await run('canva_get_brand_template', { brand_template_id: id })).brand_template.id).toBe(id);
        expect(await run('canva_get_brand_template_dataset', { brand_template_id: id })).toBeDefined();
      }
    }
  }, 90_000);

  (write ? it : it.skip)('creates a folder and a design, exports, comments, uploads an asset and cleans up', async () => {
    const folder = (await run('canva_create_folder', { name: 'AnythingMCP test', parent_folder_id: 'root' })).folder;
    try {
      const renamed = await run('canva_rename_folder', { folder_id: folder.id, name: 'AnythingMCP test (renamed)' });
      expect(renamed.folder.name).toBe('AnythingMCP test (renamed)');
      const design = (await run('canva_create_design', { design_type: { type: 'preset', name: 'doc' }, title: 'AnythingMCP live spec' })).design;
      expect(design.id).toBeDefined();
      await run('canva_move_folder_item', { item_id: design.id, to_folder_id: folder.id });
      const items = await run('canva_list_folder_items', { folder_id: folder.id, item_types: 'design' });
      expect(items.items.map((x: { design?: { id: string } }) => x.design?.id)).toContain(design.id);

      const started = await run('canva_create_export', { design_id: design.id, format: { type: 'pdf' } });
      const exported = await until(() => run('canva_get_export', { export_id: started.job.id }), (job) => job.status !== 'in_progress');
      expect(exported.status).toBe('success');
      expect(exported.urls[0]).toMatch(/^https:\/\//);

      const thread = (await run('canva_create_comment', { design_id: design.id, message_plaintext: 'AnythingMCP live spec comment' })).thread;
      expect((await run('canva_get_comment_thread', { design_id: design.id, thread_id: thread.id })).thread.id).toBe(thread.id);
      await run('canva_reply_to_comment', { design_id: design.id, thread_id: thread.id, message_plaintext: 'AnythingMCP live spec reply' });
      const replies = await run('canva_list_comment_replies', { design_id: design.id, thread_id: thread.id });
      expect(replies.items.length).toBeGreaterThan(0);

      const url = process.env.CANVA_TEST_IMAGE_URL || 'https://anythingmcp.com/apple-icon.png';
      const upload = await run('canva_upload_asset_from_url', { name: 'AnythingMCP test', url });
      const uploaded = await until(() => run('canva_get_asset_upload', { job_id: upload.job.id }), (job) => job.status !== 'in_progress');
      expect(uploaded.status).toBe('success');
      const assetId = uploaded.asset.id;
      try {
        expect((await run('canva_get_asset', { asset_id: assetId })).asset.id).toBe(assetId);
        const changed = await run('canva_update_asset', { asset_id: assetId, name: 'AnythingMCP test 2', tags: ['anythingmcp'] });
        expect(changed.asset.name).toBe('AnythingMCP test 2');
      } finally {
        await run('canva_delete_asset', { asset_id: assetId });
      }
    } finally {
      // The test design is inside, so it goes to the Trash with the folder.
      await run('canva_delete_folder', { folder_id: folder.id });
    }
  }, 240_000);
});
