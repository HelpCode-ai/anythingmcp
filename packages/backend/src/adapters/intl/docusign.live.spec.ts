import axios from 'axios';
import * as adapter from './docusign.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the DocuSign adapter:
 *
 *   1. Static: always runs. Pins the OAuth endpoints on DOCUSIGN_AUTH_URL with
 *      HTTP Basic at the token endpoint and the `signature extended` scopes,
 *      the account base path from DOCUSIGN_BASE_URI and DOCUSIGN_ACCOUNT_ID,
 *      the userinfo call on the sign-in server, every tool's method and URL,
 *      the envelope bodies (draft by default), the base64 document download,
 *      and the read-only and destructive hints.
 *
 *   2. Live: skipped unless DOCUSIGN_ACCESS_TOKEN is set (an access token of a
 *      demo account, e.g. from the OAuth helper or DocuSign's token generator).
 *      The account id and base URI come from DOCUSIGN_ACCOUNT_ID and
 *      DOCUSIGN_BASE_URI or, when unset, from the user's default account in
 *      userinfo. DOCUSIGN_AUTH_URL defaults to the demo sign-in server:
 *
 *        DOCUSIGN_ACCESS_TOKEN=eyJ0... npx jest src/adapters/intl/docusign.live.spec.ts
 *
 *      Reads userinfo, the account, recent envelopes with their recipients,
 *      documents, audit trail and form data, and templates.
 *
 *      DOCUSIGN_LIVE_WRITE=1 (demo only) creates a draft envelope with a
 *      one-page PDF addressed to the signed-in user (or
 *      DOCUSIGN_TEST_SIGNER_EMAIL), reads it, downloads its document, sends
 *      it, resends it and voids it; a draft that was never sent is moved to
 *      the recycle bin instead. With DOCUSIGN_TEMPLATE_ID and
 *      DOCUSIGN_TEMPLATE_ROLE it also creates a draft from that template and
 *      discards it.
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
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
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

const DEMO_AUTH = 'https://account-d.docusign.com';
const ACCOUNT = 'f0f1c2d3-4e5f-6789-abcd-ef0123456789';
const ENV = {
  DOCUSIGN_AUTH_URL: DEMO_AUTH,
  DOCUSIGN_BASE_URI: 'https://demo.docusign.net',
  DOCUSIGN_ACCOUNT_ID: ACCOUNT,
  DOCUSIGN_CLIENT_ID: '1a2b3c4d-1234-5678-9abc-0123456789ab',
  DOCUSIGN_CLIENT_SECRET: 'secret',
};
const BASE = `https://demo.docusign.net/restapi/v2.1/accounts/${ACCOUNT}`;
const ENVELOPE = '93be49ab-1234-4567-89ab-0123456789ab';
// Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
const execute = (name: string, env: Record<string, string>, token: string, params: Record<string, unknown>) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: config.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token }, headers: config.headers },
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters, params), ...env },
  ) as Promise<any>;
};
const call = (name: string, params: Record<string, unknown>) => execute(name, ENV, 'test-token', params);
const sent = () => mockedAxios.mock.calls[0][0];

describe('docusign adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is unlisted until verified against a real account', () => {
    expect(a.unlisted).toBe(true);
    expect(a.prerequisites).toMatch(/demo/);
  });

  it('signs in at the chosen DocuSign environment with HTTP Basic and the signature extended scopes', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{DOCUSIGN_CLIENT_ID}}',
      clientSecret: '{{DOCUSIGN_CLIENT_SECRET}}',
      authorizationUrl: '{{DOCUSIGN_AUTH_URL}}/oauth/auth',
      tokenUrl: '{{DOCUSIGN_AUTH_URL}}/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'signature extended',
    });
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
  });

  it('builds the account base path from the base URI and account id, all validated', () => {
    expect(a.requiredEnvVars).toEqual(['DOCUSIGN_CLIENT_ID', 'DOCUSIGN_CLIENT_SECRET', 'DOCUSIGN_AUTH_URL', 'DOCUSIGN_BASE_URI', 'DOCUSIGN_ACCOUNT_ID']);
    expect(a.connector.baseUrl).toBe('{{DOCUSIGN_BASE_URI}}/restapi/v2.1/accounts/{{DOCUSIGN_ACCOUNT_ID}}');
    const auth = new RegExp(a.envVarMeta.DOCUSIGN_AUTH_URL.pattern!);
    expect(auth.test(DEMO_AUTH)).toBe(true);
    expect(auth.test('https://account.docusign.com')).toBe(true);
    expect(auth.test('https://account.docusign.com.evil.example')).toBe(false);
    const base = new RegExp(a.envVarMeta.DOCUSIGN_BASE_URI.pattern!);
    for (const ok of ['https://demo.docusign.net', 'https://eu.docusign.net', 'https://na3.docusign.net', 'https://ca.docusign.net']) {
      expect(base.test(ok)).toBe(true);
    }
    expect(base.test('https://demo.docusign.net/restapi')).toBe(false);
    expect(base.test('https://docusign.net.evil.example')).toBe(false);
    const account = new RegExp(a.envVarMeta.DOCUSIGN_ACCOUNT_ID.pattern!);
    expect(account.test(ACCOUNT)).toBe(true);
    expect(account.test('12345678')).toBe(false);
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'DOCUSIGN_CLIENT_SECRET')!.secret).toBe(true);
    expect(described.find((d) => d.name === 'DOCUSIGN_BASE_URI')!.kind).toBe('address');
  });

  it('probes with the account and reads userinfo on the sign-in server, not the account host', async () => {
    expect(a.probe.tool).toBe('docusign_get_account');
    expect(tool('docusign_get_account').parameters.required).toBeUndefined();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('docusign_get_user_info', {});
    expect(sent().url).toBe(`${DEMO_AUTH}/oauth/userinfo`);
    expect(sent().headers.Authorization).toBe('Bearer test-token');
    mockedAxios.mockClear();
    await call('docusign_get_account', {});
    expect(sent().url).toBe(BASE);
  });

  it('prefixes every tool with docusign_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^docusign_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('marks reads read-only and voiding and the recycle bin destructive', () => {
    const readOnly = a.tools.filter((t) => annotationsOf(t).readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual([
      'docusign_download_document',
      'docusign_get_account',
      'docusign_get_envelope',
      'docusign_get_form_data',
      'docusign_get_template',
      'docusign_get_user_info',
      'docusign_list_audit_events',
      'docusign_list_envelope_documents',
      'docusign_list_envelopes',
      'docusign_list_recipients',
      'docusign_list_templates',
    ]);
    for (const name of ['docusign_void_envelope', 'docusign_move_envelope_to_trash']) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.destructiveHint}:${ann.idempotentHint}`).toBe(`${name}:true:false`);
    }
    // Sending and resending email people but destroy nothing.
    expect(annotationsOf(tool('docusign_send_draft_envelope')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('docusign_resend_envelope')).destructiveHint).toBe(false);
    expect(annotationsOf(tool('docusign_resend_envelope')).idempotentHint).toBe(false);
    for (const name of ['docusign_void_envelope', 'docusign_send_draft_envelope', 'docusign_resend_envelope', 'docusign_create_envelope_with_document', 'docusign_create_envelope_from_template']) {
      expect(tool(name).description).toMatch(/confirm/i);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['docusign_move_envelope_to_trash']);
  });

  it('only points the model at tools that exist, and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bdocusign_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bdocusign_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names).toContain(name);
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['docusign_get_user_info', {}, 'GET', `${DEMO_AUTH}/oauth/userinfo`],
    ['docusign_get_account', {}, 'GET', BASE],
    ['docusign_list_envelopes', { from_date: '2026-09-01' }, 'GET', `${BASE}/envelopes`],
    ['docusign_get_envelope', { envelope_id: ENVELOPE }, 'GET', `${BASE}/envelopes/${ENVELOPE}`],
    ['docusign_create_envelope_from_template', { template_id: 'T1', template_roles: [] }, 'POST', `${BASE}/envelopes`],
    ['docusign_create_envelope_with_document', { email_subject: 'S', documents: [], recipients: {} }, 'POST', `${BASE}/envelopes`],
    ['docusign_send_draft_envelope', { envelope_id: ENVELOPE }, 'PUT', `${BASE}/envelopes/${ENVELOPE}`],
    ['docusign_void_envelope', { envelope_id: ENVELOPE, voided_reason: 'Wrong file' }, 'PUT', `${BASE}/envelopes/${ENVELOPE}`],
    ['docusign_resend_envelope', { envelope_id: ENVELOPE }, 'PUT', `${BASE}/envelopes/${ENVELOPE}`],
    ['docusign_move_envelope_to_trash', { envelope_ids: [ENVELOPE] }, 'PUT', `${BASE}/folders/recyclebin`],
    ['docusign_list_recipients', { envelope_id: ENVELOPE }, 'GET', `${BASE}/envelopes/${ENVELOPE}/recipients`],
    ['docusign_list_envelope_documents', { envelope_id: ENVELOPE }, 'GET', `${BASE}/envelopes/${ENVELOPE}/documents`],
    ['docusign_download_document', { envelope_id: ENVELOPE, document_id: 'combined' }, 'GET', `${BASE}/envelopes/${ENVELOPE}/documents/combined`],
    ['docusign_list_audit_events', { envelope_id: ENVELOPE }, 'GET', `${BASE}/envelopes/${ENVELOPE}/audit_events`],
    ['docusign_get_form_data', { envelope_id: ENVELOPE }, 'GET', `${BASE}/envelopes/${ENVELOPE}/form_data`],
    ['docusign_list_templates', {}, 'GET', `${BASE}/templates`],
    ['docusign_get_template', { template_id: 'T1' }, 'GET', `${BASE}/templates/T1`],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method, url, headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('creates envelopes as drafts unless told to send', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    const roles = [{ roleName: 'Signer', name: 'Ana Diaz', email: 'ana@example.com' }];
    await call('docusign_create_envelope_from_template', { template_id: 'T1', template_roles: roles, email_subject: 'Please sign' });
    expect(sent().data).toEqual({ templateId: 'T1', templateRoles: roles, emailSubject: 'Please sign', status: 'created' });
    mockedAxios.mockClear();
    const documents = [{ documentId: '1', name: 'A.pdf', fileExtension: 'pdf', documentBase64: 'JVBERi0x' }];
    const recipients = { signers: [{ recipientId: '1', name: 'Ana', email: 'ana@example.com' }] };
    await call('docusign_create_envelope_with_document', { email_subject: 'Sign', documents, recipients, status: 'sent' });
    expect(sent().data).toEqual({ emailSubject: 'Sign', documents, recipients, status: 'sent' });
  });

  it('sends, voids, resends and trashes with the documented bodies', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('docusign_send_draft_envelope', { envelope_id: ENVELOPE });
    expect(sent().data).toEqual({ status: 'sent' });
    mockedAxios.mockClear();
    await call('docusign_void_envelope', { envelope_id: ENVELOPE, voided_reason: 'Wrong file' });
    expect(sent().data).toEqual({ status: 'voided', voidedReason: 'Wrong file' });
    mockedAxios.mockClear();
    await call('docusign_resend_envelope', { envelope_id: ENVELOPE });
    expect(sent().params).toEqual({ resend_envelope: 'true' });
    expect(sent().data).toEqual({});
    mockedAxios.mockClear();
    await call('docusign_move_envelope_to_trash', { envelope_ids: [ENVELOPE] });
    expect(sent().data).toEqual({ envelopeIds: [ENVELOPE] });
  });

  it('asks for documents as base64 text and wraps them, capped', async () => {
    mockedAxios.mockResolvedValue({ data: 'JVBERi0xLjQK', headers: { 'content-type': 'application/pdf' } });
    const body = await call('docusign_download_document', { envelope_id: ENVELOPE, document_id: '1' });
    expect(sent().headers['Content-Transfer-Encoding']).toBe('base64');
    expect(body).toBe('JVBERi0xLjQK');
    const mapping = tool('docusign_download_document').responseMapping;
    expect(applyResponseTransform(body, mapping).value).toEqual({ documentBase64: 'JVBERi0xLjQK' });
    const big = applyResponseTransform('A'.repeat(1_600_000), mapping);
    expect(big.truncated).toBe(true);
  });

  it('lists envelopes with 50 per page by default', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('docusign_list_envelopes', { from_date: '2026-09-01', status: 'sent,delivered' });
    expect(sent().params).toEqual({ from_date: '2026-09-01', status: 'sent,delivered', count: 50 });
  });
});

const TOKEN = process.env.DOCUSIGN_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

/** A one-page PDF with the anchor text "/sig1/", built with a valid xref table. */
function onePagePdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 14 Tf 72 720 Td (AnythingMCP live spec. Please sign: /sig1/) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

live('docusign adapter: live eSignature API', () => {
  const authUrl = process.env.DOCUSIGN_AUTH_URL || DEMO_AUTH;
  const write = process.env.DOCUSIGN_LIVE_WRITE === '1' && authUrl === DEMO_AUTH;
  const env: Record<string, string> = { DOCUSIGN_AUTH_URL: authUrl };
  let me: { email: string; name: string } = { email: '', name: '' };

  beforeAll(async () => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    const info = await execute('docusign_get_user_info', env, TOKEN as string, {});
    me = { email: info.email, name: info.name };
    const account = info.accounts.find((x: { account_id: string; is_default: boolean }) =>
      process.env.DOCUSIGN_ACCOUNT_ID ? x.account_id === process.env.DOCUSIGN_ACCOUNT_ID : x.is_default,
    );
    expect(account).toBeDefined();
    env.DOCUSIGN_ACCOUNT_ID = account.account_id;
    env.DOCUSIGN_BASE_URI = process.env.DOCUSIGN_BASE_URI || account.base_uri;
  }, 30_000);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(name, env, TOKEN as string, params);

  it('reads the account, recent envelopes with their details, and templates', async () => {
    const account = await run('docusign_get_account');
    expect(account.accountIdGuid ?? account.accountId).toBeDefined();
    const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const envelopes = await run('docusign_list_envelopes', { from_date: since, count: 5 });
    expect(envelopes.resultSetSize).toBeDefined();
    const first = envelopes.envelopes?.[0];
    if (first) {
      const envelope = await run('docusign_get_envelope', { envelope_id: first.envelopeId, include: 'recipients,documents' });
      expect(envelope.envelopeId).toBe(first.envelopeId);
      const recipients = await run('docusign_list_recipients', { envelope_id: first.envelopeId });
      expect(recipients.recipientCount).toBeDefined();
      const docs = await run('docusign_list_envelope_documents', { envelope_id: first.envelopeId });
      expect(Array.isArray(docs.envelopeDocuments)).toBe(true);
      const audit = await run('docusign_list_audit_events', { envelope_id: first.envelopeId });
      expect(Array.isArray(audit.auditEvents)).toBe(true);
      // Needs an account setting; a refusal must still be an API answer, not a crash.
      await run('docusign_get_form_data', { envelope_id: first.envelopeId }).catch((e: { response?: { status: number } }) => {
        expect(e.response?.status).toBeGreaterThanOrEqual(400);
      });
    }
    const templates = await run('docusign_list_templates', { count: 5 });
    expect(templates.resultSetSize).toBeDefined();
    if (templates.envelopeTemplates?.length) {
      const one = await run('docusign_get_template', { template_id: templates.envelopeTemplates[0].templateId });
      expect(one.templateId).toBe(templates.envelopeTemplates[0].templateId);
    }
  }, 90_000);

  (write ? it : it.skip)('creates a draft with a document, reads and downloads it, sends, resends and voids it', async () => {
    const signer = process.env.DOCUSIGN_TEST_SIGNER_EMAIL || me.email;
    const created = await run('docusign_create_envelope_with_document', {
      email_subject: 'AnythingMCP live spec (safe to ignore)',
      documents: [{ documentId: '1', name: 'anythingmcp-test.pdf', fileExtension: 'pdf', documentBase64: onePagePdf() }],
      recipients: {
        signers: [{ recipientId: '1', routingOrder: '1', name: me.name || 'AnythingMCP Test', email: signer, tabs: { signHereTabs: [{ anchorString: '/sig1/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '20' }] } }],
      },
    });
    expect(created.status).toBe('created');
    const id = created.envelopeId;
    let isSent = false;
    try {
      const read = await run('docusign_get_envelope', { envelope_id: id });
      expect(read.status).toBe('created');
      const docs = await run('docusign_list_envelope_documents', { envelope_id: id });
      expect(docs.envelopeDocuments.map((d: { documentId: string }) => d.documentId)).toContain('1');
      const pdf = await run('docusign_download_document', { envelope_id: id, document_id: '1' });
      expect(String(pdf).startsWith('JVBER')).toBe(true);
      await run('docusign_send_draft_envelope', { envelope_id: id });
      isSent = true;
      const recipients = await run('docusign_list_recipients', { envelope_id: id });
      expect(recipients.signers[0].email.toLowerCase()).toBe(signer.toLowerCase());
      await run('docusign_resend_envelope', { envelope_id: id });
      const audit = await run('docusign_list_audit_events', { envelope_id: id });
      expect(audit.auditEvents.length).toBeGreaterThan(0);
    } finally {
      if (isSent) {
        await run('docusign_void_envelope', { envelope_id: id, voided_reason: 'AnythingMCP live spec cleanup' });
        const voided = await run('docusign_get_envelope', { envelope_id: id });
        expect(voided.status).toBe('voided');
      } else {
        await run('docusign_move_envelope_to_trash', { envelope_ids: [id] });
      }
    }
  }, 120_000);

  (write && process.env.DOCUSIGN_TEMPLATE_ID && process.env.DOCUSIGN_TEMPLATE_ROLE ? it : it.skip)(
    'creates a draft from the given template and discards it',
    async () => {
      const created = await run('docusign_create_envelope_from_template', {
        template_id: process.env.DOCUSIGN_TEMPLATE_ID,
        template_roles: [{ roleName: process.env.DOCUSIGN_TEMPLATE_ROLE, name: me.name || 'AnythingMCP Test', email: me.email }],
        email_subject: 'AnythingMCP live spec (safe to ignore)',
      });
      try {
        expect(created.status).toBe('created');
      } finally {
        await run('docusign_move_envelope_to_trash', { envelope_ids: [created.envelopeId] });
      }
    },
    60_000,
  );
});
