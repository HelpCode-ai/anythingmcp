import axios from 'axios';
import * as adapter from './microsoft-onenote.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the OneNote (Microsoft Graph) adapter:
 *
 *   1. Static: always runs. Pins the Entra OAuth setup shared with the other
 *      Microsoft connectors (tenant in both endpoints, offline_access,
 *      Notes.ReadWrite), the page created from an HTML document sent as a raw
 *      `text/html` body, the update commands sent as a top-level JSON array,
 *      the size cap on page content, and that delete installs switched off.
 *
 *   2. Live: skipped unless MS_GRAPH_ACCESS_TOKEN is set (a delegated Graph
 *      token with Notes.ReadWrite, e.g. from Graph Explorer):
 *
 *        MS_GRAPH_ACCESS_TOKEN=eyJ... npx jest src/adapters/intl/microsoft-onenote.live.spec.ts
 *
 *      With ONENOTE_LIVE_SECTION_ID set as well, a page is created in that
 *      section, appended to, retitled and read back, then deleted in
 *      `finally`. Notebooks and sections are never created: Graph v1.0 has no
 *      way to delete them again.
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
    bodyMapping?: unknown;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  appRegistrationUrl: string;
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: {
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
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping as any, annotations: t.annotations });

const BASE = 'https://graph.microsoft.com/v1.0';
const newEngine = () =>
  new RestEngine(
    { getAccessToken: jest.fn().mockResolvedValue('test-token') } as unknown as OAuth2TokenService,
    {} as LoginTokenService,
  );
const connectorConfig = () => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig },
  headers: { ...a.connector.headers },
});
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping as any, applySchemaDefaults(tool(name).parameters as any, params));
const sent = () => mockedAxios.mock.calls[0][0];

describe('microsoft-onenote adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified live, and says up front that it needs an Entra app', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/Entra/);
    expect(a.prerequisites).toMatch(/Outlook connector can be reused/);
    expect(a.appRegistrationUrl).toMatch(/^https:\/\/entra\.microsoft\.com\//);
  });

  it('signs in against the configured tenant with the shared Microsoft variables and asks for a refresh token', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.requiredEnvVars).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID']);
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MICROSOFT_CLIENT_ID}}',
      clientSecret: '{{MICROSOFT_CLIENT_SECRET}}',
      authorizationUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/{{MICROSOFT_TENANT_ID}}/oauth2/v2.0/token',
      scopes: 'offline_access User.Read Notes.ReadWrite',
    });
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/One Entra app for all Microsoft connectors/);
    expect(a.instructions).toMatch(/read-only setup[^\n]*Notes\.Read`/);
  });

  it('probes with the notebook list, which needs no arguments', () => {
    expect(a.probe.tool).toBe('microsoft_onenote_list_notebooks');
    expect(tool('microsoft_onenote_list_notebooks').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/me/onenote/notebooks?$top=1');
  });

  it('prefixes every tool with microsoft_onenote_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^microsoft_onenote_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes every id in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs only delete switched off, and asks the model to confirm every write', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['microsoft_onenote_delete_page']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `microsoft_onenote_delete_page`/);
    expect(annotationsOf(tool('microsoft_onenote_delete_page')).destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'GET')) {
      expect(`${t.name}: ${t.description}`).toMatch(/Confirm with the user before calling\.$/);
    }
  });

  it('marks reads read-only and appending as non-destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'microsoft_onenote_get_page',
      'microsoft_onenote_get_page_content',
      'microsoft_onenote_list_notebook_section_groups',
      'microsoft_onenote_list_notebook_sections',
      'microsoft_onenote_list_notebooks',
      'microsoft_onenote_list_pages',
      'microsoft_onenote_list_section_group_sections',
      'microsoft_onenote_list_section_groups',
      'microsoft_onenote_list_section_pages',
      'microsoft_onenote_list_sections',
    ]);
    expect(annotationsOf(tool('microsoft_onenote_append_to_page')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('microsoft_onenote_update_page')).destructiveHint).toBe(true);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bmicrosoft_onenote_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bmicrosoft_onenote_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['microsoft_onenote_list_notebooks', {}, 'GET', '/me/onenote/notebooks'],
    ['microsoft_onenote_list_sections', {}, 'GET', '/me/onenote/sections'],
    ['microsoft_onenote_list_notebook_sections', { notebook_id: '1-abc' }, 'GET', '/me/onenote/notebooks/1-abc/sections'],
    ['microsoft_onenote_list_section_groups', {}, 'GET', '/me/onenote/sectionGroups'],
    ['microsoft_onenote_list_notebook_section_groups', { notebook_id: '1-abc' }, 'GET', '/me/onenote/notebooks/1-abc/sectionGroups'],
    ['microsoft_onenote_list_section_group_sections', { section_group_id: '1-sg' }, 'GET', '/me/onenote/sectionGroups/1-sg/sections'],
    ['microsoft_onenote_list_pages', {}, 'GET', '/me/onenote/pages'],
    ['microsoft_onenote_list_section_pages', { section_id: '1-s' }, 'GET', '/me/onenote/sections/1-s/pages'],
    ['microsoft_onenote_get_page', { page_id: '1-p!1' }, 'GET', '/me/onenote/pages/1-p!1'],
    ['microsoft_onenote_get_page_content', { page_id: '1-p' }, 'GET', '/me/onenote/pages/1-p/content'],
    ['microsoft_onenote_create_notebook', { display_name: 'N' }, 'POST', '/me/onenote/notebooks'],
    ['microsoft_onenote_create_section', { notebook_id: '1-abc', display_name: 'S' }, 'POST', '/me/onenote/notebooks/1-abc/sections'],
    ['microsoft_onenote_create_page', { section_id: '1-s', title: 'T', body_html: '<p>x</p>' }, 'POST', '/me/onenote/sections/1-s/pages'],
    ['microsoft_onenote_append_to_page', { page_id: '1-p', html: '<p>x</p>' }, 'PATCH', '/me/onenote/pages/1-p/content'],
    ['microsoft_onenote_update_page', { page_id: '1-p', commands: [{ target: 'title', action: 'replace', content: 'T' }] }, 'PATCH', '/me/onenote/pages/1-p/content'],
    ['microsoft_onenote_delete_page', { page_id: '1-p' }, 'DELETE', '/me/onenote/pages/1-p'],
  ])('%s sends %s to the right Graph URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        method,
        url: `${BASE}${path}`,
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('passes OData list options through and leaves unset ones out', async () => {
    mockedAxios.mockResolvedValue({ data: { value: [] } });
    await call('microsoft_onenote_list_pages', { filter: "contains(tolower(title),'q4')", top: 50, skip: 50, orderby: 'title' });
    expect(sent().params).toEqual({ $filter: "contains(tolower(title),'q4')", $top: 50, $skip: 50, $orderby: 'title' });
    mockedAxios.mockClear();
    await call('microsoft_onenote_list_notebooks', {});
    expect(sent().params).toEqual({});
    mockedAxios.mockClear();
    await call('microsoft_onenote_list_section_pages', { section_id: '1-s', page_level: true });
    expect(sent().params).toEqual({ pagelevel: true });
    mockedAxios.mockClear();
    await call('microsoft_onenote_get_page', { page_id: '1-p' });
    expect(sent().params).toEqual({ $expand: 'parentSection,parentNotebook' });
  });

  it('asks for generated element ids only when include_ids is set', async () => {
    mockedAxios.mockResolvedValue({ data: '<html></html>' });
    await call('microsoft_onenote_get_page_content', { page_id: '1-p', include_ids: true });
    expect(sent().params).toEqual({ includeIDs: true });
    mockedAxios.mockClear();
    await call('microsoft_onenote_get_page_content', { page_id: '1-p' });
    expect(sent().params).toEqual({});
  });

  it('caps very long page HTML and leaves normal pages untouched', () => {
    // A transform with only maxBytes counts as empty and is skipped; the
    // exclude (a no-op on an HTML string) is what makes the cap apply.
    const mapping = tool('microsoft_onenote_get_page_content').responseMapping!;
    expect(validateTransform(mapping.transform)).toBeNull();
    const short = '<html><head><title>Notes</title></head><body><p>Hi</p></body></html>';
    expect(applyResponseTransform(short, mapping).value).toBe(short);
    const long = `<html><body>${'<p>lorem ipsum dolor sit amet</p>'.repeat(10_000)}</body></html>`;
    const capped = applyResponseTransform(long, mapping).value as Record<string, unknown>;
    expect(capped._truncated).toBe(true);
    expect(String(capped.preview).length).toBeLessThanOrEqual(200_000);
  });

  it('creates a page from a title and HTML sent as a raw text/html document', async () => {
    mockedAxios.mockResolvedValue({ data: { id: '1-p' } });
    await call('microsoft_onenote_create_page', {
      section_id: '1-s',
      title: 'Q4 planning',
      body_html: '<p>Agenda: budget &amp; hiring</p><p data-tag="to-do">Call Anna</p>',
    });
    expect(sent().headers['Content-Type']).toBe('text/html');
    expect(sent().data).toBe(
      '<!DOCTYPE html><html><head><title>Q4 planning</title></head><body><p>Agenda: budget &amp; hiring</p><p data-tag="to-do">Call Anna</p></body></html>',
    );
  });

  it('appends with a one-command JSON array targeting the body', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('microsoft_onenote_append_to_page', { page_id: '1-p', html: '<p>Follow-up</p>' });
    expect(sent().headers['Content-Type']).toBe('application/json');
    expect(sent().data).toEqual([{ target: 'body', action: 'append', content: '<p>Follow-up</p>' }]);
  });

  it('sends update commands as the top-level JSON array Graph expects', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    const commands = [
      { target: 'title', action: 'replace', content: 'New title' },
      { target: 'p:{33f8a242-7c33-4bb2-90c5-8425a68cc5bf}{40}', action: 'insert', position: 'before', content: '<p>Above</p>' },
    ];
    await call('microsoft_onenote_update_page', { page_id: '1-p', commands });
    expect(sent().headers['Content-Type']).toBe('application/json');
    expect(sent().data).toEqual(commands);
  });

  it('names notebooks and sections with displayName', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('microsoft_onenote_create_notebook', { display_name: 'Projects' });
    expect(sent().data).toEqual({ displayName: 'Projects' });
    mockedAxios.mockClear();
    await call('microsoft_onenote_create_section', { notebook_id: '1-abc', display_name: 'Meetings' });
    expect(sent().data).toEqual({ displayName: 'Meetings' });
  });
});

const TOKEN = process.env.MS_GRAPH_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('microsoft-onenote adapter: live Graph API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    new RestEngine({} as OAuth2TokenService, {} as LoginTokenService)
      .execute(
        { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string }, headers: a.connector.headers },
        tool(name).endpointMapping as any,
        applySchemaDefaults(tool(name).parameters as any, params),
      )
      .then((raw) => applyResponseTransform(raw, tool(name).responseMapping).value);

  it('reads notebooks, sections, section groups and pages', async () => {
    const notebooks = await run('microsoft_onenote_list_notebooks', { top: 5 });
    expect(Array.isArray(notebooks.value)).toBe(true);
    const sections = await run('microsoft_onenote_list_sections', { top: 5 });
    expect(Array.isArray(sections.value)).toBe(true);
    const groups = await run('microsoft_onenote_list_section_groups', { top: 5 });
    expect(Array.isArray(groups.value)).toBe(true);
    if (notebooks.value.length) {
      const inNotebook = await run('microsoft_onenote_list_notebook_sections', { notebook_id: notebooks.value[0].id });
      expect(Array.isArray(inNotebook.value)).toBe(true);
    }
    if (sections.value.length) {
      const pages = await run('microsoft_onenote_list_section_pages', { section_id: sections.value[0].id, top: 3, page_level: true });
      expect(Array.isArray(pages.value)).toBe(true);
      if (pages.value.length) {
        const page = await run('microsoft_onenote_get_page', { page_id: pages.value[0].id });
        expect(page.id).toBe(pages.value[0].id);
        const html = await run('microsoft_onenote_get_page_content', { page_id: page.id, include_ids: true });
        expect(typeof html === 'string' ? html : html.preview).toMatch(/<html/i);
      }
    }
  }, 60_000);

  (process.env.ONENOTE_LIVE_SECTION_ID ? it : it.skip)(
    'creates a page, appends to it, retitles it, reads it back and deletes it',
    async () => {
      const stamp = new Date().toISOString();
      const page = await run('microsoft_onenote_create_page', {
        section_id: process.env.ONENOTE_LIVE_SECTION_ID,
        title: `AnythingMCP test ${stamp}`,
        body_html: '<p>Created by the AnythingMCP live test: Grüße &amp; perché</p>',
      });
      expect(typeof page.id).toBe('string');
      try {
        await run('microsoft_onenote_append_to_page', { page_id: page.id, html: '<p>Appended line</p>' });
        await run('microsoft_onenote_update_page', {
          page_id: page.id,
          commands: [{ target: 'title', action: 'replace', content: `AnythingMCP test renamed ${stamp}` }],
        });
        const html = await run('microsoft_onenote_get_page_content', { page_id: page.id });
        expect(html).toContain('Appended line');
        expect(html).toContain('AnythingMCP test renamed');
      } finally {
        await run('microsoft_onenote_delete_page', { page_id: page.id });
      }
    },
    120_000,
  );
});
