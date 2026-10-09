import axios from 'axios';
import * as adapter from './google-docs.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Docs adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters and the way the read tools keep a document small: a `fields`
 *      mask that asks Google only for text runs and positions, then a
 *      JMESPath transform that joins them into plain text (or positioned
 *      blocks), capped at 200 KB. Also the batchUpdate bodies of the edit
 *      tools and which tools install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (documents.readonly
 *      for reads, documents for the write round-trip). Reads Google's public
 *      sample document, the same one the probe uses:
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-docs.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP test document" is
 *      created, edited, read back and moved to the trash in `finally`
 *      through the Drive API (the token then also needs the drive or
 *      drive.file scope; without it the test names the file to delete).
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    // The outbound helper also calls axios.getUri, getAdapter and friends:
    // keep every real static, only the call itself is mocked.
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
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
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
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
const shaped = (name: string, raw: unknown): any => applyResponseTransform(raw, tool(name).responseMapping).value;

const BASE = 'https://docs.googleapis.com/v1';
const SAMPLE = '195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE';
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
// Arguments as DynamicMcpTools hands them to the engine: schema defaults filled in.
const call = (name: string, params: Record<string, unknown>) =>
  newEngine().execute(connectorConfig(), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));
const sent = () => mockedAxios.mock.calls[0][0];

const run = (content: string) => ({ textRun: { content } });
const para = (startIndex: number, endIndex: number, style: string, ...texts: string[]) => ({
  startIndex,
  endIndex,
  paragraph: { paragraphStyle: { namedStyleType: style }, elements: texts.map(run) },
});
// The shape documents.get returns for the requested field mask.
const FIXTURE = {
  documentId: 'd1',
  title: 'Offer',
  revisionId: 'rev-1',
  body: {
    content: [
      { endIndex: 1 },
      para(1, 7, 'TITLE', 'Offer\n'),
      para(7, 26, 'NORMAL_TEXT', 'Dear ', '[Customer name]', ',\n'),
      {
        startIndex: 26,
        endIndex: 40,
        table: {
          rows: 1,
          columns: 2,
          tableRows: [
            { tableCells: [{ content: [{ paragraph: { elements: [run('Item\n')] } }] }, { content: [{ paragraph: { elements: [run('Price\n')] } }] }] },
          ],
        },
      },
      { startIndex: 40, endIndex: 52, paragraph: { elements: [{ inlineObjectElement: {} }, run('Grüße 👋\n')] } },
    ],
  },
};

describe('google-docs adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live on 9 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with the shared Google OAuth client and the documents scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/documents',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toMatch(/read-only setup[^\n]*documents\.readonly/);
    // Long or multi-tab documents are pointed at the Drive export.
    expect(a.instructions).toContain('gdrive_export_file');
  });

  it("probes by reading Google's public sample document, since Docs has no list call", () => {
    expect(a.probe).toEqual({ tool: 'gdocs_get_document_text', params: { document_id: SAMPLE } });
    expect(a.connector.healthcheckPath).toBe(`/documents/${SAMPLE}?fields=documentId`);
  });

  it('prefixes every tool with gdocs_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^gdocs_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('percent-encodes ids placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('installs only the raw batchUpdate switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['gdocs_batch_update']);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `gdocs_batch_update`/);
    expect(annotationsOf(tool('gdocs_batch_update')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('gdocs_replace_all_text')).destructiveHint).toBe(true);
  });

  it('marks the reads read-only', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['gdocs_get_document_structure', 'gdocs_get_document_text']);
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgdocs_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgdocs_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(5);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('asks Google only for text runs and positions', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gdocs_get_document_text', { document_id: 'd/1' });
    expect(sent().url).toBe(`${BASE}/documents/d%2F1`);
    expect(sent().params.fields).toBe(
      'documentId,title,revisionId,body(content(startIndex,endIndex,paragraph(elements(textRun(content))),table(tableRows(tableCells(content(paragraph(elements(textRun(content)))))))))',
    );
    mockedAxios.mockClear();
    await call('gdocs_get_document_structure', { document_id: 'd1' });
    expect(sent().params.fields).toContain('paragraphStyle(namedStyleType)');
    expect(sent().params.fields).toContain('table(rows,columns,');
  });

  it('turns the document into plain text, tables included, in order', () => {
    for (const name of ['gdocs_get_document_text', 'gdocs_get_document_structure']) {
      expect(validateTransform(tool(name).responseMapping!.transform)).toBeNull();
      expect(tool(name).responseMapping!.transform!.maxBytes).toBe(200_000);
    }
    expect(shaped('gdocs_get_document_text', FIXTURE)).toEqual({
      documentId: 'd1',
      title: 'Offer',
      revisionId: 'rev-1',
      endIndex: 52,
      text: 'Offer\nDear [Customer name],\nItem\nPrice\nGrüße 👋\n',
    });
  });

  it('lists paragraphs and tables with their positions and styles', () => {
    const out = shaped('gdocs_get_document_structure', FIXTURE);
    expect(out.endIndex).toBe(52);
    expect(out.blocks).toEqual([
      { startIndex: 1, endIndex: 7, type: 'paragraph', style: 'TITLE', rows: null, columns: null, text: 'Offer\n' },
      { startIndex: 7, endIndex: 26, type: 'paragraph', style: 'NORMAL_TEXT', rows: null, columns: null, text: 'Dear [Customer name],\n' },
      { startIndex: 26, endIndex: 40, type: 'table', style: null, rows: 1, columns: 2, text: 'Item\nPrice\n' },
      { startIndex: 40, endIndex: 52, type: 'paragraph', style: null, rows: null, columns: null, text: 'Grüße 👋\n' },
    ]);
  });

  it('caps a huge document instead of flooding the context', () => {
    const huge = { ...FIXTURE, body: { content: [para(1, 300_001, 'NORMAL_TEXT', 'x'.repeat(300_000))] } };
    const outcome = applyResponseTransform(huge, tool('gdocs_get_document_text').responseMapping);
    expect(outcome.truncated).toBe(true);
    expect(JSON.stringify(outcome.value).length).toBeLessThan(210_000);
  });

  it('builds the batchUpdate bodies of the edit tools', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('gdocs_append_text', { document_id: 'd1', text: '\nNew paragraph' });
    expect(sent().url).toBe(`${BASE}/documents/d1:batchUpdate`);
    expect(sent().data).toEqual({ requests: [{ insertText: { text: '\nNew paragraph', endOfSegmentLocation: {} } }] });
    mockedAxios.mockClear();
    await call('gdocs_insert_text', { document_id: 'd1', index: 7, text: 'Intro\n' });
    expect(sent().data).toEqual({ requests: [{ insertText: { text: 'Intro\n', location: { index: 7 } } }] });
    mockedAxios.mockClear();
    await call('gdocs_replace_all_text', { document_id: 'd1', find: '[Customer name]', replace_with: 'Ana', match_case: false });
    expect(sent().data).toEqual({
      requests: [{ replaceAllText: { containsText: { text: '[Customer name]', matchCase: false }, replaceText: 'Ana' } }],
    });
    mockedAxios.mockClear();
    // An empty replacement leaves replaceText out, which Docs reads as "".
    await call('gdocs_replace_all_text', { document_id: 'd1', find: 'DRAFT', replace_with: '' });
    expect(sent().data).toEqual({ requests: [{ replaceAllText: { containsText: { text: 'DRAFT' } } }] });
    mockedAxios.mockClear();
    await call('gdocs_create_document', { title: 'Notes' });
    expect(sent().url).toBe(`${BASE}/documents`);
    expect(sent().data).toEqual({ title: 'Notes' });
    mockedAxios.mockClear();
    const requests = [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }];
    await call('gdocs_batch_update', { document_id: 'd1', requests, write_control: { requiredRevisionId: 'rev-1' } });
    expect(sent().data).toEqual({ requests, writeControl: { requiredRevisionId: 'rev-1' } });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-docs adapter: live Docs API', () => {
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const bearer = (baseUrl: string) => ({
    baseUrl,
    authType: 'BEARER_TOKEN',
    authConfig: { token: TOKEN as string },
    headers: a.connector.headers,
  });
  const exec = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine().execute(bearer(a.connector.baseUrl), tool(name).endpointMapping, applySchemaDefaults(tool(name).parameters, params));

  it('runs the probe on the public sample document and reads it as text and blocks', async () => {
    const raw = await exec(a.probe.tool, a.probe.params);
    expect(raw.documentId).toBe(SAMPLE);
    const text = shaped('gdocs_get_document_text', raw);
    expect(typeof text.text).toBe('string');
    expect(text.text.length).toBeGreaterThan(0);
    const blocks = shaped('gdocs_get_document_structure', await exec('gdocs_get_document_structure', { document_id: SAMPLE }));
    expect(blocks.blocks.length).toBeGreaterThan(0);
    expect(typeof blocks.blocks[0].startIndex).toBe('number');
  }, 30_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test document, appends, inserts and replaces text, then trashes it',
    async () => {
      const doc = await exec('gdocs_create_document', { title: `AnythingMCP test document ${new Date().toISOString()}` });
      const id = doc.documentId as string;
      try {
        await exec('gdocs_append_text', { document_id: id, text: 'Dear [Customer name],\nthanks.' });
        await exec('gdocs_insert_text', { document_id: id, index: 1, text: 'AnythingMCP test\n' });
        const replaced = await exec('gdocs_replace_all_text', { document_id: id, find: '[Customer name]', replace_with: 'Jürgen 👋' });
        expect(replaced.replies[0].replaceAllText.occurrencesChanged).toBe(1);
        const text = shaped('gdocs_get_document_text', await exec('gdocs_get_document_text', { document_id: id }));
        expect(text.text).toBe('AnythingMCP test\nDear Jürgen 👋,\nthanks.\n');
      } finally {
        await engine()
          .execute(
            bearer('https://www.googleapis.com/drive/v3'),
            { method: 'PATCH', path: '/files/{id}', encodePathParams: true, bodyMapping: { trashed: true } },
            { id },
          )
          .catch(() => console.warn(`Could not trash test document ${id}: delete it by hand.`));
      }
    },
    90_000,
  );
});
