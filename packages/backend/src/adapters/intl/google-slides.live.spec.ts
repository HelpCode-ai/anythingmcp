import axios from 'axios';
import * as adapter from './google-slides.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Slides adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, the `fields` masks and JMESPath transforms that turn a deck
 *      into text slide by slide (Slides answers are otherwise megabytes of
 *      styling), the batchUpdate bodies of the edit tools and which tools
 *      install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set (presentations.readonly
 *      for reads, presentations for the write round-trip). Reads Google's
 *      public sample presentation, the one the probe uses:
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/google-slides.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well, an "AnythingMCP test presentation"
 *      is created, edited with every write tool, read back and moved to the
 *      trash in `finally` through the Drive API (the token then also needs
 *      the drive or drive.file scope; without it the test names the file to
 *      delete).
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

const BASE = 'https://slides.googleapis.com/v1';
const SAMPLE = '1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc';
const READS = ['google_slides_get_page', 'google_slides_get_page_thumbnail', 'google_slides_get_presentation'];
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

const text = (...runs: string[]) => ({ text: { textElements: [{ paragraphMarker: {} }, ...runs.map((content) => ({ textRun: { content } }))] } });
// The shape presentations.get returns for the requested field mask.
const FIXTURE = {
  presentationId: 'p1',
  title: 'Q3 review',
  revisionId: 'rev-1',
  locale: 'de',
  pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } },
  layouts: [{ objectId: 'l1', layoutProperties: { name: 'TITLE_AND_BODY', displayName: 'Titel und Text' } }],
  slides: [
    {
      objectId: 's1',
      slideProperties: {
        layoutObjectId: 'l1',
        notesPage: {
          notesProperties: { speakerNotesObjectId: 'n1' },
          pageElements: [{ shape: {} }, { shape: text('Say hello 👋\n') }],
        },
      },
      pageElements: [
        { objectId: 'e1', shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'TITLE' }, ...text('Q3 ', 'review\n') } },
        { objectId: 'e2', shape: { shapeType: 'TEXT_BOX', ...text('Grüße\n') } },
        { objectId: 'e3', image: { contentUrl: 'https://lh3.example/x' } },
        {
          objectId: 'e4',
          table: { rows: 1, columns: 2, tableRows: [{ tableCells: [text('Item\n'), text('Price\n')] }] },
        },
        { objectId: 'e5', shape: { shapeType: 'RECTANGLE' } },
        { objectId: 'e6', elementGroup: { children: [{ objectId: 'c1' }] } },
      ],
    },
    { objectId: 's2', slideProperties: { layoutObjectId: 'l1' } },
  ],
};

describe('google-slides adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real Google account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and the presentations scope', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/presentations',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('enable **Google Slides API**');
    expect(a.instructions).toMatch(/read-only setup[^\n]*presentations\.readonly/);
    expect(a.instructions).toContain('gdrive_search_files');
  });

  it("probes by reading Google's public sample presentation, since Slides has no list call", () => {
    expect(a.probe).toEqual({ tool: 'google_slides_get_presentation', params: { presentation_id: SAMPLE } });
    expect(a.connector.healthcheckPath).toBe(`/presentations/${SAMPLE}?fields=presentationId`);
  });

  it('prefixes every tool with google_slides_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_slides_[a-z_]+$/);
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

  it('installs deleting and the raw batchUpdate switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([
      'google_slides_delete_object',
      'google_slides_batch_update',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `google_slides_delete_object` and `google_slides_batch_update`/);
    for (const name of ['google_slides_delete_object', 'google_slides_batch_update', 'google_slides_replace_all_text']) {
      expect(annotationsOf(tool(name)).destructiveHint).toBe(true);
    }
  });

  it('marks the reads read-only and asks for confirmation before every write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READS);
    for (const t of a.tools) {
      if (READS.includes(t.name)) continue;
      expect(`${t.name}: ${t.description}`).toMatch(/[Cc]onfirm (the change )?with the user/);
    }
    expect(annotationsOf(tool('google_slides_move_slides'))).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_slides_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_slides_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('asks Google only for ids, types and text runs', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_slides_get_presentation', { presentation_id: 'p/1' });
    expect(sent().url).toBe(`${BASE}/presentations/p%2F1`);
    const fields: string = sent().params.fields;
    expect(fields).toContain('textElements(textRun(content))');
    expect(fields).toContain('notesProperties(speakerNotesObjectId)');
    expect(fields).toContain('layouts(objectId,layoutProperties(name,displayName))');
    // No styling, no full text style objects.
    expect(fields).not.toMatch(/style/i);
    mockedAxios.mockClear();
    await call('google_slides_get_page', { presentation_id: 'p1', page_id: 's1' });
    expect(sent().url).toBe(`${BASE}/presentations/p1/pages/s1`);
    expect(sent().params.fields).toContain('pageElements(objectId,title,description,size,transform,');
    mockedAxios.mockClear();
    await call('google_slides_get_page_thumbnail', { presentation_id: 'p1', page_id: 's1' });
    expect(sent().url).toBe(`${BASE}/presentations/p1/pages/s1/thumbnail`);
    expect(sent().params).toEqual({ 'thumbnailProperties.thumbnailSize': 'MEDIUM', 'thumbnailProperties.mimeType': 'PNG' });
  });

  it('turns a deck into text slide by slide, with element ids, types and speaker notes', () => {
    for (const name of ['google_slides_get_presentation', 'google_slides_get_page']) {
      expect(validateTransform(tool(name).responseMapping!.transform)).toBeNull();
      expect(tool(name).responseMapping!.transform!.maxBytes).toBe(200_000);
    }
    expect(shaped('google_slides_get_presentation', FIXTURE)).toEqual({
      presentationId: 'p1',
      title: 'Q3 review',
      revisionId: 'rev-1',
      locale: 'de',
      pageSize: FIXTURE.pageSize,
      slideCount: 2,
      slides: [
        {
          objectId: 's1',
          layoutObjectId: 'l1',
          notesObjectId: 'n1',
          notes: 'Say hello 👋\n',
          elements: [
            { objectId: 'e1', type: 'TITLE', text: 'Q3 review\n' },
            { objectId: 'e2', type: 'TEXT_BOX', text: 'Grüße\n' },
            { objectId: 'e3', type: 'IMAGE', text: '' },
            { objectId: 'e4', type: 'TABLE', text: 'Item\nPrice\n' },
            { objectId: 'e5', type: 'RECTANGLE', text: '' },
            { objectId: 'e6', type: 'GROUP', text: '' },
          ],
        },
        { objectId: 's2', layoutObjectId: 'l1', notesObjectId: null, notes: '', elements: null },
      ],
      layouts: [{ objectId: 'l1', name: 'TITLE_AND_BODY', displayName: 'Titel und Text' }],
    });
  });

  it('reads an empty deck without failing', () => {
    expect(shaped('google_slides_get_presentation', { presentationId: 'p0', title: 'Empty' })).toMatchObject({
      presentationId: 'p0',
      slideCount: 0,
      slides: null,
    });
  });

  it('lists a page with positions, sizes and group children', () => {
    const size = { width: { magnitude: 3000000, unit: 'EMU' }, height: { magnitude: 400000, unit: 'EMU' } };
    const transform = { scaleX: 1, scaleY: 1, translateX: 311700, translateY: 744575, unit: 'EMU' };
    const page = {
      objectId: 's1',
      pageType: 'SLIDE',
      slideProperties: FIXTURE.slides[0].slideProperties,
      pageElements: [
        { objectId: 'e1', size, transform, shape: { shapeType: 'TEXT_BOX', placeholder: { type: 'BODY', index: 1 }, ...text('A\n') } },
        { objectId: 'e6', elementGroup: { children: [{ objectId: 'c1' }, { objectId: 'c2' }] } },
        { objectId: 'e7', title: 'Logo', image: { contentUrl: 'https://lh3.example/x', sourceUrl: 'https://example.com/logo.png' } },
      ],
    };
    const out = shaped('google_slides_get_page', page);
    expect(out).toMatchObject({ objectId: 's1', pageType: 'SLIDE', notesObjectId: 'n1', notes: 'Say hello 👋\n' });
    expect(out.elements[0]).toMatchObject({ objectId: 'e1', type: 'BODY', placeholderIndex: 1, text: 'A\n', size, transform });
    expect(out.elements[1]).toMatchObject({ type: 'GROUP', children: ['c1', 'c2'] });
    expect(out.elements[2]).toMatchObject({ type: 'IMAGE', title: 'Logo', imageSourceUrl: 'https://example.com/logo.png' });
    // The temporary contentUrl is not passed on.
    expect(JSON.stringify(out)).not.toContain('lh3.example');
  });

  it('caps a huge deck instead of flooding the context', () => {
    const big = { ...FIXTURE, slides: [{ objectId: 's1', pageElements: [{ objectId: 'e1', shape: text('x'.repeat(300_000)) }] }] };
    const outcome = applyResponseTransform(big, tool('google_slides_get_presentation').responseMapping);
    expect(outcome.truncated).toBe(true);
    expect(JSON.stringify(outcome.value).length).toBeLessThan(210_000);
  });

  it('creates a presentation with a title only and returns its first slide placeholders', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_slides_create_presentation', { title: 'Offer' });
    expect(sent().url).toBe(`${BASE}/presentations`);
    expect(sent().data).toEqual({ title: 'Offer' });
    expect(sent().params.fields).toBe('presentationId,title,revisionId,slides(objectId,pageElements(objectId,shape(placeholder(type))))');
  });

  it('builds the batchUpdate bodies of the edit tools', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, { presentation_id: 'p1', ...params });
      expect(sent().method).toBe('POST');
      expect(sent().url).toBe(`${BASE}/presentations/p1:batchUpdate`);
      return sent().data;
    };
    expect(await body('google_slides_add_slide', {})).toEqual({
      requests: [{ createSlide: { slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' } } }],
    });
    expect(await body('google_slides_add_slide', { layout: 'BLANK', insertion_index: 0, object_id: 'slide_intro' })).toEqual({
      requests: [{ createSlide: { objectId: 'slide_intro', insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'BLANK' } } }],
    });
    expect(await body('google_slides_duplicate_object', { object_id: 's1' })).toEqual({ requests: [{ duplicateObject: { objectId: 's1' } }] });
    expect(await body('google_slides_move_slides', { slide_ids: ['s2', 's3'], insertion_index: 0 })).toEqual({
      requests: [{ updateSlidesPosition: { slideObjectIds: ['s2', 's3'], insertionIndex: 0 } }],
    });
    expect(await body('google_slides_insert_text', { object_id: 'e1', text: 'Hallo\nWelt' })).toEqual({
      requests: [{ insertText: { objectId: 'e1', text: 'Hallo\nWelt' } }],
    });
    expect(await body('google_slides_insert_text', { object_id: 'e1', text: '!', insertion_index: 5 })).toEqual({
      requests: [{ insertText: { objectId: 'e1', text: '!', insertionIndex: 5 } }],
    });
    expect(await body('google_slides_add_text_box', { slide_id: 's1', object_id: 'tb_1', text: 'Note' })).toEqual({
      requests: [
        {
          createShape: {
            objectId: 'tb_1',
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: 's1',
              size: { width: { magnitude: 400, unit: 'PT' }, height: { magnitude: 100, unit: 'PT' } },
              transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 50, unit: 'PT' },
            },
          },
        },
        { insertText: { objectId: 'tb_1', text: 'Note' } },
      ],
    });
    expect(await body('google_slides_replace_all_text', { find: '[Customer name]', replace_with: 'Ana', match_case: true, page_ids: ['s2'] })).toEqual({
      requests: [{ replaceAllText: { containsText: { text: '[Customer name]', matchCase: true }, replaceText: 'Ana', pageObjectIds: ['s2'] } }],
    });
    // An empty replacement leaves replaceText out, which Slides reads as "".
    expect(await body('google_slides_replace_all_text', { find: 'DRAFT', replace_with: '' })).toEqual({
      requests: [{ replaceAllText: { containsText: { text: 'DRAFT' } } }],
    });
    expect(await body('google_slides_create_image', { slide_id: 's1', url: 'https://example.com/a.png', x_pt: 10, y_pt: 20 })).toEqual({
      requests: [
        {
          createImage: {
            url: 'https://example.com/a.png',
            elementProperties: {
              pageObjectId: 's1',
              size: { width: { magnitude: 300, unit: 'PT' }, height: { magnitude: 200, unit: 'PT' } },
              transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: 'PT' },
            },
          },
        },
      ],
    });
    expect(await body('google_slides_delete_object', { object_id: 'e5' })).toEqual({ requests: [{ deleteObject: { objectId: 'e5' } }] });
    const requests = [{ deleteText: { objectId: 'e1', textRange: { type: 'ALL' } } }];
    expect(await body('google_slides_batch_update', { requests, write_control: { requiredRevisionId: 'rev-1' } })).toEqual({
      requests,
      writeControl: { requiredRevisionId: 'rev-1' },
    });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('google-slides adapter: live Slides API', () => {
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
  const read = async (name: string, params: Record<string, unknown>) => shaped(name, await exec(name, params));

  it('runs the probe on the public sample deck, reads a page and renders a thumbnail', async () => {
    const deck = await read(a.probe.tool, a.probe.params!);
    expect(deck.presentationId).toBe(SAMPLE);
    expect(deck.slideCount).toBeGreaterThan(0);
    const first = deck.slides[0].objectId as string;
    const page = await read('google_slides_get_page', { presentation_id: SAMPLE, page_id: first });
    expect(page.objectId).toBe(first);
    expect(Array.isArray(page.elements)).toBe(true);
    const thumb = await exec('google_slides_get_page_thumbnail', { presentation_id: SAMPLE, page_id: first, size: 'SMALL' });
    expect(thumb.width).toBe(200);
    expect(thumb.contentUrl).toMatch(/^https:\/\//);
  }, 60_000);

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test presentation, edits it with every write tool, then trashes it',
    async () => {
      const created = await exec('google_slides_create_presentation', { title: `AnythingMCP test presentation ${new Date().toISOString()}` });
      const id = created.presentationId as string;
      const p = { presentation_id: id };
      try {
        const slide = await exec('google_slides_add_slide', { ...p, layout: 'TITLE_AND_BODY' });
        const slideId = slide.replies[0].createSlide.objectId as string;
        const page = await read('google_slides_get_page', { ...p, page_id: slideId });
        const title = page.elements.find((e: any) => e.type === 'TITLE');
        expect(title).toBeDefined();
        await exec('google_slides_insert_text', { ...p, object_id: title.objectId, text: 'Offer for [Customer name]' });
        await exec('google_slides_insert_text', { ...p, object_id: page.notesObjectId, text: 'Speaker note 👋' });
        await exec('google_slides_add_text_box', { ...p, slide_id: slideId, object_id: 'amcp_test_box', text: 'Grüße', y_pt: 300 });
        const image = await exec('google_slides_create_image', {
          ...p,
          slide_id: slideId,
          url: 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png',
          width_pt: 136,
          height_pt: 46,
        });
        const imageId = image.replies[0].createImage.objectId as string;
        const copy = await exec('google_slides_duplicate_object', { ...p, object_id: slideId });
        const copyId = copy.replies[0].duplicateObject.objectId as string;
        const replaced = await exec('google_slides_replace_all_text', { ...p, find: '[Customer name]', replace_with: 'Jürgen', page_ids: [copyId] });
        expect(replaced.replies[0].replaceAllText.occurrencesChanged).toBe(1);
        await exec('google_slides_move_slides', { ...p, slide_ids: [copyId], insertion_index: 0 });
        await exec('google_slides_delete_object', { ...p, object_id: imageId });
        const deck = await read('google_slides_get_presentation', p);
        expect(deck.slides[0].objectId).toBe(copyId);
        const texts = deck.slides.flatMap((s: any) => s.elements.map((e: any) => e.text)).join('|');
        expect(texts).toContain('Offer for Jürgen');
        expect(texts).toContain('Offer for [Customer name]');
        expect(texts).toContain('Grüße');
        expect(deck.slides.find((s: any) => s.objectId === slideId).notes).toContain('Speaker note 👋');
        expect(deck.slides.find((s: any) => s.objectId === slideId).elements.some((e: any) => e.objectId === imageId)).toBe(false);
        const raw = await exec('google_slides_batch_update', {
          ...p,
          requests: [{ updateTextStyle: { objectId: 'amcp_test_box', textRange: { type: 'ALL' }, style: { bold: true }, fields: 'bold' } }],
        });
        expect(raw.presentationId).toBe(id);
      } finally {
        await engine()
          .execute(
            bearer('https://www.googleapis.com/drive/v3'),
            { method: 'PATCH', path: '/files/{id}', encodePathParams: true, bodyMapping: { trashed: true } },
            { id },
          )
          .catch(() => console.warn(`Could not trash test presentation ${id}: delete it by hand.`));
      }
    },
    120_000,
  );
});
