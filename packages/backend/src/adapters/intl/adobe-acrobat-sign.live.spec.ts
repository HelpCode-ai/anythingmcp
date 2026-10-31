import * as adapter from './adobe-acrobat-sign.json';

/**
 * Adobe Acrobat Sign REST API v6 (developer.adobe.com/acrobat-sign, OpenAPI at
 * secure.na1.adobesign.com/restapijson/v6/restapi.json): OAuth 2.0 authorization code on
 * the account's shard (secure.<shard>.adobesign.com/public/oauth/v2, token at
 * api.<shard>.adobesign.com/oauth/v2/token, refresh at /oauth/v2/refresh),
 * API base https://api.<shard>.adobesign.com/api/rest/v6.
 * Live part (reads only: base URIs, me, agreements, library documents, web forms, groups, workflows):
 *   ADOBE_SIGN_ACCESS_TOKEN=<access token> ADOBE_SIGN_SHARD=na1 RUN_ADOBE_ACROBAT_SIGN_LIVE=1 npx jest src/adapters/intl/adobe-acrobat-sign
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; bodyEncoding?: string; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { binary?: { maxBytes?: number } };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
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
const P = 'adobe_acrobat_sign_';
const WRITES = [`${P}upload_transient_document`, `${P}create_agreement`, `${P}send_agreement`, `${P}cancel_agreement`, `${P}create_reminder`];
const SHARD = 'https://api.{{ADOBE_SIGN_SHARD}}.adobesign.com';

describe('adobe-acrobat-sign adapter: static spec conformance', () => {
  it('signs in with OAuth 2.0 on the account shard, refreshing at /oauth/v2/refresh', () => {
    expect(a.slug).toBe('adobe-acrobat-sign');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-signature');
    expect(a.icon).toBe('adobe-acrobat-sign');
    expect(a.requiredEnvVars).toEqual(['ADOBE_SIGN_SHARD', 'ADOBE_SIGN_CLIENT_ID', 'ADOBE_SIGN_CLIENT_SECRET']);
    expect(a.connector.baseUrl).toBe(`${SHARD}/api/rest/v6`);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{ADOBE_SIGN_CLIENT_ID}}',
      clientSecret: '{{ADOBE_SIGN_CLIENT_SECRET}}',
      authorizationUrl: 'https://secure.{{ADOBE_SIGN_SHARD}}.adobesign.com/public/oauth/v2',
      tokenUrl: `${SHARD}/oauth/v2/token`,
      refreshUrl: `${SHARD}/oauth/v2/refresh`,
      tokenAuthMethod: 'client_secret_post',
      scopes: 'user_read agreement_read agreement_write agreement_send library_read widget_read workflow_read webhook_read',
    });
    expect(a.envVarMeta?.ADOBE_SIGN_CLIENT_SECRET.secret).toBe(true);
    const shard = new RegExp(a.envVarMeta?.ADOBE_SIGN_SHARD.pattern as string);
    for (const ok of ['na1', 'na4', 'eu2', 'jp1', 'au1', 'in1', 'sg1']) expect(shard.test(ok)).toBe(true);
    for (const bad of ['https://api.na1.adobesign.com', 'NA1', 'na1.adobesign.com']) expect(shard.test(bad)).toBe(false);
  });

  it('maps agreement reads to the v6 routes and query names', () => {
    expect(tool(`${P}get_base_uris`).endpointMapping).toEqual({ method: 'GET', path: '/baseUris' });
    expect(tool(`${P}get_user`).endpointMapping).toEqual({ method: 'GET', path: '/users/{user_id}' });
    expect(tool(`${P}get_user`).parameters?.properties?.user_id.default).toBe('me');
    expect(tool(`${P}list_agreements`).endpointMapping).toEqual({
      method: 'GET',
      path: '/agreements',
      queryParams: { externalId: '$external_id', groupId: '$group_id', showHiddenAgreements: '$show_hidden', cursor: '$cursor', pageSize: '$page_size' },
    });
    expect(tool(`${P}get_agreement`).endpointMapping.path).toBe('/agreements/{agreement_id}');
    expect(tool(`${P}get_agreement_members`).endpointMapping).toEqual({ method: 'GET', path: '/agreements/{agreement_id}/members', queryParams: { includeNextParticipantSet: '$include_next_participant_set' } });
    expect(tool(`${P}list_agreement_events`).endpointMapping.path).toBe('/agreements/{agreement_id}/events');
    expect(tool(`${P}get_agreement_form_data`).endpointMapping).toEqual({ method: 'GET', path: '/agreements/{agreement_id}/formData', queryParams: { allowInProcessAgreement: '$allow_in_process', participantId: '$participant_id' } });
    expect(tool(`${P}get_signing_urls`).endpointMapping).toEqual({ method: 'GET', path: '/agreements/{agreement_id}/signingUrls', queryParams: { expiry: '$expiry' } });
    expect(tool(`${P}get_combined_document_url`).endpointMapping.path).toBe('/agreements/{agreement_id}/combinedDocument/url');
    expect(tool(`${P}list_agreement_documents`).endpointMapping.path).toBe('/agreements/{agreement_id}/documents');
    expect(tool(`${P}list_reminders`).endpointMapping).toEqual({ method: 'GET', path: '/agreements/{agreement_id}/reminders', queryParams: { status: '$status' } });
  });

  it('hands PDFs over as files', () => {
    expect(tool(`${P}download_combined_document`).endpointMapping.path).toBe('/agreements/{agreement_id}/combinedDocument');
    expect(tool(`${P}download_audit_trail`).endpointMapping.path).toBe('/agreements/{agreement_id}/auditTrail');
    for (const n of [`${P}download_combined_document`, `${P}download_audit_trail`]) expect(tool(n).responseMapping?.binary).toEqual({ maxBytes: 10485760 });
  });

  it('searches agreement assets with the AGREEMENT_ASSETS scope, read-only over POST', () => {
    expect(tool(`${P}search_agreements`).endpointMapping).toEqual({
      method: 'POST',
      path: '/search',
      bodyMapping: {
        scope: ['AGREEMENT_ASSETS'],
        query: '$query',
        agreementAssetsCriteria: {
          status: '$status', role: '$role', type: '$type', participantEmail: '$participant_email', externalId: '$external_id', createdDate: '$created_date', modifiedDate: '$modified_date',
          queryableFields: '$queryable_fields', sortByField: '$sort_by_field', sortOrder: '$sort_order', startIndex: '$start_index', pageSize: '$page_size',
        },
      },
    });
    expect(tool(`${P}search_agreements`).annotations?.readOnlyHint).toBe(true);
  });

  it('maps templates, web forms, users, groups, workflows and webhooks', () => {
    expect(tool(`${P}list_library_documents`).endpointMapping.queryParams).toEqual({ groupId: '$group_id', showHiddenLibraryDocuments: '$show_hidden', cursor: '$cursor', pageSize: '$page_size' });
    expect(tool(`${P}get_library_document`).endpointMapping.path).toBe('/libraryDocuments/{library_document_id}');
    expect(tool(`${P}list_library_document_form_fields`).endpointMapping.path).toBe('/libraryDocuments/{library_document_id}/formFields');
    expect(tool(`${P}list_web_forms`).endpointMapping).toMatchObject({ path: '/widgets', queryParams: { showHiddenWidgets: '$show_hidden' } });
    expect(tool(`${P}get_web_form`).endpointMapping.path).toBe('/widgets/{widget_id}');
    expect(tool(`${P}get_web_form_form_data`).endpointMapping.path).toBe('/widgets/{widget_id}/formData');
    expect(tool(`${P}list_web_form_agreements`).endpointMapping.path).toBe('/widgets/{widget_id}/agreements');
    expect(tool(`${P}list_users`).endpointMapping).toMatchObject({ path: '/users', queryParams: { accountAdminFilter: '$account_admin_filter' } });
    expect(tool(`${P}list_groups`).endpointMapping.path).toBe('/groups');
    expect(tool(`${P}list_group_users`).endpointMapping.path).toBe('/groups/{group_id}/users');
    expect(tool(`${P}list_workflows`).endpointMapping).toEqual({ method: 'GET', path: '/workflows', queryParams: { groupId: '$group_id', includeDraftWorkflows: '$include_draft', includeInactiveWorkflows: '$include_inactive' } });
    expect(tool(`${P}get_workflow`).endpointMapping.path).toBe('/workflows/{workflow_id}');
    expect(tool(`${P}list_webhooks`).endpointMapping).toMatchObject({ path: '/webhooks', queryParams: { showInActiveWebhooks: '$show_inactive', scope: '$scope', resourceType: '$resource_type' } });
    expect(tool(`${P}get_webhook`).endpointMapping.path).toBe('/webhooks/{webhook_id}');
  });

  it('uploads a transient document as multipart File, File-Name and Mime-Type', () => {
    expect(tool(`${P}upload_transient_document`).endpointMapping).toEqual({
      method: 'POST',
      path: '/transientDocuments',
      bodyEncoding: 'form-data',
      bodyMapping: { File: { __file: '$file_url' }, 'File-Name': '$file_name', 'Mime-Type': '$mime_type' },
    });
  });

  it('creates, sends, cancels and reminds with the documented bodies', () => {
    expect(tool(`${P}create_agreement`).endpointMapping).toEqual({
      method: 'POST',
      path: '/agreements',
      bodyMapping: {
        name: '$name', fileInfos: '$file_infos', participantSetsInfo: '$participant_sets', state: '$state', signatureType: '$signature_type', message: '$message', ccs: '$ccs',
        expirationTime: '$expiration_time', reminderFrequency: '$reminder_frequency', mergeFieldInfo: '$merge_field_info', externalId: '$external_id', groupId: '$group_id', locale: '$locale',
      },
    });
    expect(tool(`${P}create_agreement`).parameters?.required).toEqual(['name', 'file_infos', 'participant_sets', 'state']);
    expect(tool(`${P}create_agreement`).parameters?.properties?.state.enum).toEqual(['IN_PROCESS', 'DRAFT', 'AUTHORING']);
    expect(tool(`${P}create_agreement`).parameters?.properties?.signature_type.default).toBe('ESIGN');
    expect(tool(`${P}send_agreement`).endpointMapping).toEqual({ method: 'PUT', path: '/agreements/{agreement_id}/state', bodyMapping: { state: 'IN_PROCESS' } });
    expect(tool(`${P}cancel_agreement`).endpointMapping).toEqual({
      method: 'PUT',
      path: '/agreements/{agreement_id}/state',
      bodyMapping: { state: 'CANCELLED', agreementCancellationInfo: { comment: '$comment', notifyOthers: '$notify_others' } },
    });
    // notifyOthers is required inside agreementCancellationInfo, so it always has a value.
    expect(tool(`${P}cancel_agreement`).parameters?.properties?.notify_others.default).toBe(false);
    expect(tool(`${P}create_reminder`).endpointMapping).toEqual({
      method: 'POST',
      path: '/agreements/{agreement_id}/reminders',
      bodyMapping: { recipientParticipantIds: '$participant_ids', status: 'ACTIVE', note: '$note', frequency: '$frequency', firstReminderDelay: '$first_reminder_delay' },
    });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('annotates the writes, marks state changes destructive and keeps the other reads on GET', () => {
    const writes = a.tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${t.name === `${P}cancel_agreement` ? false : undefined}`);
      if (!WRITES.includes(t.name) && t.name !== `${P}search_agreements`) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
    }
    for (const n of [`${P}send_agreement`, `${P}cancel_agreement`]) expect(tool(n).annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe(`${P}get_base_uris`);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_ADOBE_ACROBAT_SIGN_LIVE === '1' && process.env.ADOBE_SIGN_ACCESS_TOKEN && process.env.ADOBE_SIGN_SHARD ? describe : describe.skip;
live('adobe-acrobat-sign adapter: live (read-only)', () => {
  const base = a.connector.baseUrl.replace('{{ADOBE_SIGN_SHARD}}', process.env.ADOBE_SIGN_SHARD as string);
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.ADOBE_SIGN_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads base URIs, the current user, agreements, templates, web forms, groups and workflows', async () => {
    const uris = await get('/baseUris');
    expect(String(uris.apiAccessPoint)).toContain(process.env.ADOBE_SIGN_SHARD as string);
    expect(typeof (await get('/users/me')).email).toBe('string');
    expect(Array.isArray((await get('/agreements?pageSize=5')).userAgreementList)).toBe(true);
    expect(Array.isArray((await get('/libraryDocuments?pageSize=5')).libraryDocumentList)).toBe(true);
    expect(Array.isArray((await get('/widgets?pageSize=5')).userWidgetList)).toBe(true);
    expect(Array.isArray((await get('/workflows')).userWorkflowList)).toBe(true);
  }, 60_000);
});
