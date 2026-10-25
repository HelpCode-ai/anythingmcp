import axios from 'axios';
import * as adapter from './firebase.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Firebase adapter:
 *
 *   1. Static: always runs. Pins the Google OAuth setup and every tool's
 *      method, URL, query and body through the real RestEngine, checked
 *      against Google's discovery documents (fetched 15 Oct 2026):
 *      firebase v1beta1, firestore v1, identitytoolkit v1,
 *      firebaseremoteconfig v1 and fcm v1. Five hosts behind one connector, so
 *      every tool outside firebase.googleapis.com carries an absolute URL.
 *      Also pins that password hashes never leave, that the risky writes
 *      install switched off, and the Firestore query shaping.
 *
 *   2. Live: skipped unless RUN_FIREBASE_LIVE=1. Without a token it checks that
 *      Google refuses a fake one with 401 on the real routes and answers 404
 *      on a made-up one. With FIREBASE_ACCESS_TOKEN (cloud-platform scope, e.g.
 *      from the OAuth 2.0 Playground) and FIREBASE_PROJECT_ID it lists
 *      projects, apps, collections, users (one page) and reads Remote Config.
 *      FIREBASE_LIVE_WRITE=1 also creates, updates and deletes one document in
 *      the collection `amcp_live_test`:
 *
 *        RUN_FIREBASE_LIVE=1 FIREBASE_ACCESS_TOKEN=ya29... FIREBASE_PROJECT_ID=my-app \
 *          npx jest src/adapters/intl/firebase.live.spec.ts
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
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; headers?: Record<string, string>; exposeHeaders?: string[]; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const FB = 'https://firebase.googleapis.com/v1beta1';
const FS = 'https://firestore.googleapis.com/v1/projects/p1/databases/(default)';
const IT = 'https://identitytoolkit.googleapis.com/v1/projects/p1';
const RC = 'https://firebaseremoteconfig.googleapis.com/v1/projects/p1';
const engine = (token = 'test-token') =>
  new RestEngine({ getAccessToken: jest.fn().mockResolvedValue(token) } as unknown as OAuth2TokenService, {} as LoginTokenService);
const call = (name: string, params: Record<string, unknown>, token?: string) =>
  engine(token).execute(
    { baseUrl: a.connector.baseUrl, authType: a.connector.authType, authConfig: { ...a.connector.authConfig }, headers: { ...a.connector.headers } } as any,
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters as any, params),
  ) as Promise<any>;
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any);
const sent = () => mockedAxios.mock.calls[0][0];

const OFF = ['firebase_delete_document', 'firebase_publish_remote_config', 'firebase_send_message'];
const WRITES = [
  'firebase_create_document',
  'firebase_delete_document',
  'firebase_publish_remote_config',
  'firebase_send_message',
  'firebase_set_user_disabled',
  'firebase_update_document',
];

describe('firebase adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('firebase');
  });

  it('signs in with the shared Google OAuth client and the cloud-platform scope, and explains why', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(describeAdapterEnvVars(a as never).find((m) => m.name === 'GOOGLE_CLIENT_SECRET')).toMatchObject({ secret: true });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    for (const scope of ['`firebase`', '`datastore`', 'cloud-platform']) expect(a.instructions).toContain(scope);
    expect(a.instructions).toMatch(/Crashlytics has no documented public REST API/);
  });

  it('checks the connection on a cheap authenticated list', () => {
    expect(a.connector.baseUrl).toBe('https://firebase.googleapis.com');
    expect(a.connector.healthcheckPath).toBe('/v1beta1/projects?pageSize=1');
    expect(a.probe).toEqual({ tool: 'firebase_list_projects', params: { pageSize: 1 } });
  });

  it('prefixes every tool with firebase_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^firebase_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks POST reads read-only, every write a write, and installs delete, publish and send switched off', () => {
    const writes = a.tools.filter((t) => annotationsOf(t).readOnlyHint !== true).map((t) => t.name).sort();
    expect(writes).toEqual(WRITES);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(OFF);
    for (const name of WRITES) expect(tool(name).description).toMatch(/[Cc]onfirm/);
    expect(annotationsOf(tool('firebase_set_user_disabled'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf(tool('firebase_delete_document'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('only points the model at tools that exist, documents every tool and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfirebase_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfirebase_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('carries valid response mappings that do real work (delete returns an empty body)', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      if (!tr) {
        expect(t.name).toBe('firebase_delete_document');
        continue;
      }
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.expression ?? tr.exclude ?? tr.include).toBeDefined();
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['firebase_list_projects', {}, 'GET', `${FB}/projects`],
    ['firebase_get_project', { project_id: 'p1' }, 'GET', `${FB}/projects/p1`],
    ['firebase_list_apps', { project_id: 'p1' }, 'GET', `${FB}/projects/p1:searchApps`],
    ['firebase_list_collections', { project_id: 'p1' }, 'POST', `${FS}/documents:listCollectionIds`],
    ['firebase_list_documents', { project_id: 'p1', collection_path: 'users' }, 'GET', `${FS}/documents/users`],
    ['firebase_get_document', { project_id: 'p1', document_path: 'users/abc' }, 'GET', `${FS}/documents/users/abc`],
    ['firebase_query_documents', { project_id: 'p1', collection_id: 'orders' }, 'POST', `${FS}/documents:runQuery`],
    ['firebase_create_document', { project_id: 'p1', collection_path: 'users', fields: {} }, 'POST', `${FS}/documents/users`],
    ['firebase_update_document', { project_id: 'p1', document_path: 'users/abc', fields: {} }, 'PATCH', `${FS}/documents/users/abc`],
    ['firebase_delete_document', { project_id: 'p1', document_path: 'users/abc' }, 'DELETE', `${FS}/documents/users/abc`],
    ['firebase_lookup_users', { project_id: 'p1', emails: ['a@example.com'] }, 'POST', `${IT}/accounts:lookup`],
    ['firebase_list_users', { project_id: 'p1' }, 'GET', `${IT}/accounts:batchGet`],
    ['firebase_set_user_disabled', { project_id: 'p1', uid: 'u1', disabled: true }, 'POST', `${IT}/accounts:update`],
    ['firebase_get_remote_config', { project_id: 'p1' }, 'GET', `${RC}/remoteConfig`],
    ['firebase_list_remote_config_versions', { project_id: 'p1' }, 'GET', `${RC}/remoteConfig:listVersions`],
    ['firebase_publish_remote_config', { project_id: 'p1', etag: 'etag-1', parameters: {} }, 'PUT', `${RC}/remoteConfig`],
    ['firebase_send_message', { project_id: 'p1', topic: 'news' }, 'POST', 'https://fcm.googleapis.com/v1/projects/p1/messages:send'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the discovery-document URL with the OAuth token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(req.headers.Authorization).toBe('Bearer test-token');
  });

  it('reaches subcollections, named databases and nested documents', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('firebase_list_collections', { project_id: 'p1', parent: 'documents/users/abc', database_id: 'eu-db' });
    expect(sent().url).toBe('https://firestore.googleapis.com/v1/projects/p1/databases/eu-db/documents/users/abc:listCollectionIds');
    mockedAxios.mockClear();
    await call('firebase_list_documents', { project_id: 'p1', collection_path: 'users/abc/orders', fields: ['total', 'status'] });
    expect(sent().url).toBe(`${FS}/documents/users/abc/orders`);
    expect(sent().params).toEqual({ pageSize: 20, 'mask.fieldPaths': ['total', 'status'] });
    mockedAxios.mockClear();
    await call('firebase_query_documents', { project_id: 'p1', parent: 'documents/users/abc', collection_id: 'orders' });
    expect(sent().url).toBe(`${FS}/documents/users/abc:runQuery`);
  });

  it('builds a structured query with a small default limit', async () => {
    mockedAxios.mockResolvedValue({ data: [] });
    const where = { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'open' } } };
    const order_by = [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }];
    await call('firebase_query_documents', { project_id: 'p1', collection_id: 'orders', where, order_by });
    expect(sent().data).toEqual({
      structuredQuery: { from: [{ collectionId: 'orders', allDescendants: false }], where, orderBy: order_by, limit: 20 },
    });
  });

  it('updates only the listed fields of an existing document, and deletes only an existing one', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const fields = { status: { stringValue: 'shipped' } };
    await call('firebase_update_document', { project_id: 'p1', document_path: 'orders/o1', fields, update_fields: ['status'] });
    expect(sent().params).toEqual({ 'updateMask.fieldPaths': ['status'], 'currentDocument.exists': 'true' });
    expect(sent().data).toEqual({ fields });
    mockedAxios.mockClear();
    await call('firebase_create_document', { project_id: 'p1', collection_path: 'orders', document_id: 'o2', fields });
    expect(sent().params).toEqual({ documentId: 'o2' });
    expect(sent().data).toEqual({ fields });
  });

  it('looks users up by the identity toolkit field names and disables with disableUser', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('firebase_lookup_users', { project_id: 'p1', emails: ['a@example.com'], uids: ['u1'] });
    expect(sent().data).toEqual({ email: ['a@example.com'], localId: ['u1'] });
    mockedAxios.mockClear();
    await call('firebase_set_user_disabled', { project_id: 'p1', uid: 'u1', disabled: true });
    expect(sent().data).toEqual({ localId: 'u1', disableUser: true });
  });

  it('publishes Remote Config only with the etag in If-Match, and sends FCM in the v1 envelope', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: { etag: 'etag-2' } });
    const parameters = { welcome: { defaultValue: { value: 'Hi' } } };
    await call('firebase_publish_remote_config', { project_id: 'p1', etag: 'etag-1', parameters, conditions: [], validate_only: true });
    expect(sent().headers['If-Match']).toBe('etag-1');
    expect(sent().params).toEqual({ validateOnly: true });
    expect(sent().data).toEqual({ conditions: [], parameters });
    expect(tool('firebase_get_remote_config').endpointMapping.exposeHeaders).toEqual(['etag']);
    mockedAxios.mockClear();
    await call('firebase_send_message', { project_id: 'p1', topic: 'news', notification: { title: 'T', body: 'B' }, validate_only: true });
    expect(sent().data).toEqual({ message: { topic: 'news', notification: { title: 'T', body: 'B' } }, validateOnly: true });
  });

  it('never returns password hashes or salts', () => {
    const user = { localId: 'u1', email: 'a@example.com', passwordHash: 'HASH', salt: 'SALT', providerUserInfo: [{ providerId: 'password', rawId: 'a@example.com' }], disabled: false };
    for (const name of ['firebase_lookup_users', 'firebase_list_users']) {
      const out = shape(name, { kind: 'x', users: [user], nextPageToken: 'n' });
      expect(out.error).toBeUndefined();
      const text = JSON.stringify(out.value);
      expect(text).not.toContain('HASH');
      expect(text).not.toContain('SALT');
      expect((out.value as any).users[0]).toMatchObject({ uid: 'u1', email: 'a@example.com', providers: ['password'], disabled: false });
    }
  });

  it('turns a runQuery stream into a document list', () => {
    const doc = (id: string) => ({ name: `projects/p1/databases/(default)/documents/orders/${id}`, fields: { total: { integerValue: '5' } }, createTime: 't1', updateTime: 't2' });
    const out = shape('firebase_query_documents', [
      { document: doc('a'), readTime: 'r1' },
      { document: doc('b'), readTime: 'r1' },
    ]);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ documents: [doc('a'), doc('b')], readTime: 'r1' });
    const empty = shape('firebase_query_documents', [{ readTime: 'r2' }]);
    expect(empty.value).toEqual({ documents: [], readTime: 'r2' });
  });
});

const live = process.env.RUN_FIREBASE_LIVE === '1' ? describe : describe.skip;
live('firebase adapter: live', () => {
  const token = process.env.FIREBASE_ACCESS_TOKEN;
  const project = process.env.FIREBASE_PROJECT_ID;
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['firebase_list_projects', {}],
    ['firebase_get_project', { project_id: 'p1' }],
    ['firebase_list_apps', { project_id: 'p1' }],
    ['firebase_list_collections', { project_id: 'p1' }],
    ['firebase_list_documents', { project_id: 'p1', collection_path: 'users' }],
    ['firebase_get_document', { project_id: 'p1', document_path: 'users/abc' }],
    ['firebase_query_documents', { project_id: 'p1', collection_id: 'users' }],
    ['firebase_lookup_users', { project_id: 'p1', emails: ['a@example.com'] }],
    ['firebase_list_users', { project_id: 'p1' }],
    ['firebase_get_remote_config', { project_id: 'p1' }],
    ['firebase_list_remote_config_versions', { project_id: 'p1' }],
  ])('%s reaches a real route and Google refuses a fake token (401)', async (name, params) => {
    await expect(call(name, params, 'ya29.fake-token')).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it.each([
    'https://firebase.googleapis.com/v1beta1/does-not-exist',
    'https://firestore.googleapis.com/v1/does-not-exist',
    'https://identitytoolkit.googleapis.com/v1/does-not-exist',
    'https://firebaseremoteconfig.googleapis.com/v1/does-not-exist',
  ])('answers 404 on the made-up route %s', async (url) => {
    await expect((mockedAxios.__actual as any).request({ url, method: 'GET', headers: { Authorization: 'Bearer ya29.fake' } })).rejects.toMatchObject({
      response: { status: 404 },
    });
  }, 30000);

  const run = async (name: string, params: Record<string, unknown>) => {
    const out = shape(name, await call(name, params, token));
    expect(out.error).toBeUndefined();
    return out.value as any;
  };

  (token && project ? it : it.skip)('lists projects, apps, collections and one page of users, and reads Remote Config', async () => {
    const projects = await run('firebase_list_projects', { pageSize: 50 });
    expect(projects.projects.map((p: { projectId: string }) => p.projectId)).toContain(project);
    expect(Array.isArray((await run('firebase_list_apps', { project_id: project })).apps ?? [])).toBe(true);
    expect(await run('firebase_list_collections', { project_id: project })).toBeDefined();
    const users = await run('firebase_list_users', { project_id: project, maxResults: 2 });
    expect(JSON.stringify(users)).not.toMatch(/passwordHash|"salt"/);
    expect(await run('firebase_list_remote_config_versions', { project_id: project, pageSize: 2 })).toBeDefined();
  }, 120000);

  (token && project && process.env.FIREBASE_LIVE_WRITE === '1' ? it : it.skip)('creates, reads, updates and deletes one test document', async () => {
    const id = `amcp-${Date.now()}`;
    const path = `amcp_live_test/${id}`;
    try {
      await run('firebase_create_document', { project_id: project, collection_path: 'amcp_live_test', document_id: id, fields: { n: { integerValue: '1' } } });
      await run('firebase_update_document', { project_id: project, document_path: path, fields: { n: { integerValue: '2' } }, update_fields: ['n'] });
      const doc = await run('firebase_get_document', { project_id: project, document_path: path });
      expect(doc.fields.n.integerValue).toBe('2');
      const found = await run('firebase_query_documents', {
        project_id: project,
        collection_id: 'amcp_live_test',
        where: { fieldFilter: { field: { fieldPath: 'n' }, op: 'EQUAL', value: { integerValue: '2' } } },
        limit: 5,
      });
      expect(found.documents.length).toBeGreaterThan(0);
    } finally {
      await call('firebase_delete_document', { project_id: project, document_path: path }, token).catch(() => undefined);
    }
  }, 120000);
});
