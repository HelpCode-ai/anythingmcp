import axios from 'axios';
import * as adapter from './google-forms.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Google Forms adapter:
 *
 *   1. Static: always runs. Pins the OAuth setup shared by the Google
 *      adapters, the two narrow Forms scopes, the probe (Google's tokeninfo,
 *      because the Forms API has no call without a form id), the createItem,
 *      updateFormInfo, updateSettings and setPublishSettings bodies, the
 *      response filter, and which tools install switched off.
 *
 *   2. Live: skipped unless GOOGLE_ACCESS_TOKEN is set. The probe works with
 *      any token; with GOOGLE_FORMS_FORM_ID (a form the account can edit) the
 *      form and its responses are read as well (forms.body.readonly and
 *      forms.responses.readonly are enough):
 *
 *        GOOGLE_ACCESS_TOKEN=ya29... GOOGLE_FORMS_FORM_ID=1FAIp... \
 *          npx jest src/adapters/intl/google-forms.live.spec.ts
 *
 *      With GOOGLE_LIVE_WRITE=1 as well (forms.body), an "AnythingMCP test
 *      form" is created, filled with questions, renamed, made a quiz,
 *      published and closed, and moved to the trash in `finally` through the
 *      Drive API (the token then also needs the drive or drive.file scope;
 *      without it the test names the file to delete).
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

const BASE = 'https://forms.googleapis.com/v1';
const TOKENINFO = 'https://www.googleapis.com/oauth2/v3/tokeninfo';
const READS = [
  'google_forms_check_authorization',
  'google_forms_get_form',
  'google_forms_get_response',
  'google_forms_list_responses',
  'google_forms_list_watches',
];
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

describe('google-forms adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until it has been tried with a real Google account', () => {
    expect(a.unlisted).toBe(true);
  });

  it('signs in with the shared Google OAuth client and only the two Forms scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/forms.responses.readonly',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('enable **Google Forms API**');
    expect(a.instructions).toMatch(/read-only setup[^\n]*forms\.body\.readonly/);
    // Creation takes a title only, and API-made forms start unpublished.
    expect(a.instructions).toMatch(/takes only a title/);
    expect(a.instructions).toMatch(/start \*\*unpublished\*\*/);
    expect(tool('google_forms_create_form').description).toContain('google_forms_set_publish_settings');
  });

  it("probes Google's tokeninfo with the connector's token, since every Forms call needs a form id", async () => {
    expect(a.probe).toEqual({ tool: 'google_forms_check_authorization' });
    expect(tool('google_forms_check_authorization').parameters.required).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe(TOKENINFO);
    mockedAxios.mockResolvedValue({
      data: { azp: 'x.apps.googleusercontent.com', aud: 'x', sub: '1', scope: 'https://www.googleapis.com/auth/forms.body', exp: '1', expires_in: '3599', access_type: 'offline' },
    });
    const raw = await call('google_forms_check_authorization', {});
    expect(sent()).toMatchObject({ method: 'GET', url: TOKENINFO, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) });
    // The token travels in the header, never in the URL.
    expect(sent().params).toBeUndefined();
    expect(shaped('google_forms_check_authorization', raw)).toEqual({
      scope: 'https://www.googleapis.com/auth/forms.body',
      expiresIn: '3599',
    });
  });

  it('prefixes every tool with google_forms_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^google_forms_[a-z_]+$/);
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

  it('installs the raw batchUpdate and deleting a watch switched off, and says so', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual([
      'google_forms_batch_update',
      'google_forms_delete_watch',
    ]);
    expect(a.instructions).toMatch(/Switched off at install\*\*: `google_forms_batch_update`[^\n]*`google_forms_delete_watch`/);
    expect(annotationsOf(tool('google_forms_batch_update')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('google_forms_delete_watch')).destructiveHint).toBe(true);
  });

  it('marks the reads read-only and asks for confirmation before every write', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(READS);
    for (const t of a.tools) {
      if (READS.includes(t.name)) continue;
      expect(`${t.name}: ${t.description}`).toMatch(/[Cc]onfirm (the change )?with the user/);
    }
    expect(annotationsOf(tool('google_forms_set_publish_settings'))).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('only points the model at tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bgoogle_forms_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bgoogle_forms_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it.each([
    ['google_forms_get_form', { form_id: 'f/1' }, 'GET', '/forms/f%2F1'],
    ['google_forms_create_form', { title: 'T' }, 'POST', '/forms'],
    ['google_forms_set_publish_settings', { form_id: 'f1', is_published: true, is_accepting_responses: true }, 'POST', '/forms/f1:setPublishSettings'],
    ['google_forms_list_responses', { form_id: 'f1' }, 'GET', '/forms/f1/responses'],
    ['google_forms_get_response', { form_id: 'f1', response_id: 'r1' }, 'GET', '/forms/f1/responses/r1'],
    ['google_forms_list_watches', { form_id: 'f1' }, 'GET', '/forms/f1/watches'],
    ['google_forms_create_watch', { form_id: 'f1', topic_name: 'projects/p/topics/t', event_type: 'RESPONSES' }, 'POST', '/forms/f1/watches'],
    ['google_forms_renew_watch', { form_id: 'f1', watch_id: 'w1' }, 'POST', '/forms/f1/watches/w1:renew'],
    ['google_forms_delete_watch', { form_id: 'f1', watch_id: 'w1' }, 'DELETE', '/forms/f1/watches/w1'],
  ])('%s sends %s to the right Forms URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url: `${BASE}${path}`, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('creates a form with the title only', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_forms_create_form', { title: 'Feedback' });
    expect(sent().data).toEqual({ info: { title: 'Feedback' } });
    mockedAxios.mockClear();
    await call('google_forms_create_form', { title: 'Feedback', document_title: 'Feedback 2026' });
    expect(sent().data).toEqual({ info: { title: 'Feedback', documentTitle: 'Feedback 2026' } });
  });

  it('builds createItem requests for text, choice and raw items', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const body = async (name: string, params: Record<string, unknown>) => {
      mockedAxios.mockClear();
      await call(name, { form_id: 'f1', ...params });
      expect(sent().url).toBe(`${BASE}/forms/f1:batchUpdate`);
      return sent().data;
    };
    expect(await body('google_forms_add_text_question', { index: 0, title: 'Your name' })).toEqual({
      requests: [{ createItem: { item: { title: 'Your name', questionItem: { question: { textQuestion: {} } } }, location: { index: 0 } } }],
    });
    expect(await body('google_forms_add_text_question', { index: 2, title: 'Comments', description: 'Optional', required: false, paragraph: true })).toEqual({
      requests: [
        {
          createItem: {
            item: { title: 'Comments', description: 'Optional', questionItem: { question: { required: false, textQuestion: { paragraph: true } } } },
            location: { index: 2 },
          },
        },
      ],
    });
    const options = [{ value: 'Yes' }, { value: 'No' }, { isOther: true }];
    expect(await body('google_forms_add_choice_question', { index: 1, title: 'Coming?', options, required: true })).toEqual({
      requests: [
        {
          createItem: {
            item: { title: 'Coming?', questionItem: { question: { required: true, choiceQuestion: { type: 'RADIO', options } } } },
            location: { index: 1 },
          },
        },
      ],
    });
    const item = { title: 'Rate us', questionItem: { question: { scaleQuestion: { low: 1, high: 5 } } } };
    expect(await body('google_forms_add_item', { index: 3, item })).toEqual({ requests: [{ createItem: { item, location: { index: 3 } } }] });
  });

  it('updates info and settings with an explicit mask, and publishes with both flags', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_forms_update_form_info', { form_id: 'f1', description: 'Takes 2 minutes', update_mask: 'description' });
    expect(sent().data).toEqual({ requests: [{ updateFormInfo: { info: { description: 'Takes 2 minutes' }, updateMask: 'description' } }] });
    mockedAxios.mockClear();
    await call('google_forms_update_settings', { form_id: 'f1', is_quiz: false, update_mask: 'quizSettings.isQuiz' });
    expect(sent().data).toEqual({ requests: [{ updateSettings: { settings: { quizSettings: { isQuiz: false } }, updateMask: 'quizSettings.isQuiz' } }] });
    mockedAxios.mockClear();
    await call('google_forms_update_settings', { form_id: 'f1', email_collection_type: 'VERIFIED', update_mask: 'emailCollectionType' });
    expect(sent().data.requests[0].updateSettings).toMatchObject({ settings: { emailCollectionType: 'VERIFIED' }, updateMask: 'emailCollectionType' });
    mockedAxios.mockClear();
    await call('google_forms_set_publish_settings', { form_id: 'f1', is_published: true, is_accepting_responses: false });
    expect(sent().data).toEqual({ publishSettings: { publishState: { isPublished: true, isAcceptingResponses: false } }, updateMask: 'publishState' });
    expect(tool('google_forms_set_publish_settings').parameters.required).toEqual(['form_id', 'is_published', 'is_accepting_responses']);
  });

  it('filters responses by submission time and pages them', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_forms_list_responses', { form_id: 'f1' });
    expect(sent().params).toEqual({ pageSize: 100 });
    mockedAxios.mockClear();
    await call('google_forms_list_responses', { form_id: 'f1', submitted_since: '2026-10-01T00:00:00Z', page_size: 500, page_token: 'tok' });
    expect(sent().params).toEqual({ filter: 'timestamp >= 2026-10-01T00:00:00Z', pageSize: 500, pageToken: 'tok' });
    for (const name of ['google_forms_get_form', 'google_forms_list_responses']) {
      expect(validateTransform(tool(name).responseMapping!.transform)).toBeNull();
      const huge = { responses: [{ responseId: 'r', answers: { q: { textAnswers: { answers: [{ value: 'x'.repeat(300_000) }] } } } }] };
      const outcome = applyResponseTransform(huge, tool(name).responseMapping);
      expect(outcome.truncated).toBe(true);
      // A normal answer passes through unchanged.
      const small = { responses: [{ responseId: 'r1', answers: { q1: { questionId: 'q1', textAnswers: { answers: [{ value: 'Ja' }] } } } }] };
      expect(shaped(name, small)).toEqual(small);
    }
  });

  it('creates a watch on a Pub/Sub topic and passes raw batchUpdate requests through', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('google_forms_create_watch', { form_id: 'f1', topic_name: 'projects/p/topics/t', event_type: 'RESPONSES', watch_id: 'amcp-1' });
    expect(sent().data).toEqual({ watch: { target: { topic: { topicName: 'projects/p/topics/t' } }, eventType: 'RESPONSES' }, watchId: 'amcp-1' });
    mockedAxios.mockClear();
    const requests = [{ deleteItem: { location: { index: 3 } } }];
    await call('google_forms_batch_update', { form_id: 'f1', requests, write_control: { requiredRevisionId: 'r9' }, include_form_in_response: true });
    expect(sent().data).toEqual({ requests, writeControl: { requiredRevisionId: 'r9' }, includeFormInResponse: true });
  });
});

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const FORM_ID = process.env.GOOGLE_FORMS_FORM_ID;
const live = TOKEN ? describe : describe.skip;

live('google-forms adapter: live Forms API', () => {
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

  it('runs the probe: the token is valid and its scopes are listed', async () => {
    const out = shaped(a.probe.tool, await exec(a.probe.tool));
    expect(typeof out.scope).toBe('string');
    expect(Number(out.expiresIn)).toBeGreaterThan(0);
  }, 30_000);

  (FORM_ID ? it : it.skip)(
    'reads the form in GOOGLE_FORMS_FORM_ID and its first page of responses',
    async () => {
      const form = await exec('google_forms_get_form', { form_id: FORM_ID });
      expect(form.formId).toBe(FORM_ID);
      expect(typeof form.info.title).toBe('string');
      const page = await exec('google_forms_list_responses', { form_id: FORM_ID, page_size: 5 });
      if (page.responses?.length) {
        const one = await exec('google_forms_get_response', { form_id: FORM_ID, response_id: page.responses[0].responseId });
        expect(one.responseId).toBe(page.responses[0].responseId);
      }
      const watches = await exec('google_forms_list_watches', { form_id: FORM_ID });
      expect(typeof watches).toBe('object');
    },
    60_000,
  );

  (process.env.GOOGLE_LIVE_WRITE === '1' ? it : it.skip)(
    'creates a test form, adds questions, edits info and settings, publishes and closes it, then trashes it',
    async () => {
      const created = await exec('google_forms_create_form', { title: `AnythingMCP test form ${new Date().toISOString()}` });
      const id = created.formId as string;
      try {
        const text = await exec('google_forms_add_text_question', { form_id: id, index: 0, title: 'Your name 👋', required: true });
        expect(text.replies[0].createItem.questionId).toHaveLength(1);
        await exec('google_forms_add_choice_question', {
          form_id: id,
          index: 1,
          title: 'Kommst du?',
          choice_type: 'CHECKBOX',
          options: [{ value: 'Ja' }, { value: 'Nein' }, { isOther: true }],
        });
        await exec('google_forms_add_item', {
          form_id: id,
          index: 2,
          item: { title: 'Rate us', questionItem: { question: { scaleQuestion: { low: 1, high: 5, lowLabel: 'Bad', highLabel: 'Great' } } } },
        });
        await exec('google_forms_update_form_info', { form_id: id, description: 'Grüße, perché', update_mask: 'description' });
        await exec('google_forms_update_settings', { form_id: id, is_quiz: true, update_mask: 'quizSettings.isQuiz' });
        const published = await exec('google_forms_set_publish_settings', { form_id: id, is_published: true, is_accepting_responses: true });
        expect(published.publishSettings.publishState).toEqual({ isPublished: true, isAcceptingResponses: true });
        await exec('google_forms_set_publish_settings', { form_id: id, is_published: true, is_accepting_responses: false });
        await exec('google_forms_batch_update', { form_id: id, requests: [{ deleteItem: { location: { index: 2 } } }] });
        const form = await exec('google_forms_get_form', { form_id: id });
        expect(form.info.description).toBe('Grüße, perché');
        expect(form.settings.quizSettings.isQuiz).toBe(true);
        expect(form.items.map((i: any) => i.title)).toEqual(['Your name 👋', 'Kommst du?']);
        expect(form.items[1].questionItem.question.choiceQuestion.type).toBe('CHECKBOX');
        expect(form.publishSettings.publishState.isAcceptingResponses).toBe(false);
        const responses = await exec('google_forms_list_responses', { form_id: id });
        expect(responses.responses ?? []).toEqual([]);
      } finally {
        await engine()
          .execute(
            bearer('https://www.googleapis.com/drive/v3'),
            { method: 'PATCH', path: '/files/{id}', encodePathParams: true, bodyMapping: { trashed: true } },
            { id },
          )
          .catch(() => console.warn(`Could not trash test form ${id}: delete it by hand.`));
      }
    },
    120_000,
  );
});
