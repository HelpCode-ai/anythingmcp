import * as adapter from './boldsign.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * BoldSign API v1 (developers.boldsign.com, OpenAPI at https://api.boldsign.com/swagger/v1/swagger.json,
 * regional hosts as in github.com/boldsign/boldsign-mcp): X-API-KEY header, base
 * https://api.boldsign.com, https://api-eu.boldsign.com, https://api-ca.boldsign.com or https://api-au.boldsign.com.
 * Live part (reads only: documents, templates, brands, contacts, one document):
 *   BOLDSIGN_API_KEY=... [BOLDSIGN_API_URL=https://api-eu.boldsign.com] RUN_BOLDSIGN_LIVE=1 npx jest src/adapters/intl/boldsign
 * A Sandbox key allows 50 requests an hour.
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string; default?: unknown; items?: { enum?: unknown[] } }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean }>;
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
const P = 'boldsign_';
const READS = [
  'list_documents', 'list_team_documents', 'list_behalf_documents', 'get_document', 'download_document', 'download_audit_log',
  'get_embedded_sign_link', 'list_templates', 'get_template', 'list_sender_identities', 'get_sender_identity', 'list_contacts',
  'get_contact', 'list_teams', 'get_team', 'list_users', 'get_user', 'list_brands', 'get_brand', 'get_api_credits',
].map((n) => `${P}${n}`);
const PAGE = { Page: '$page', PageSize: '$page_size' };
const DOC_FILTERS = {
  SearchKey: '$search', Status: '$status', TransmitType: '$transmit_type', StartDate: '$start_date', EndDate: '$end_date',
  DateFilterType: '$date_filter_type', Labels: '$labels', BrandIds: '$brand_ids', NextCursor: '$next_cursor',
};
const SEND = {
  title: '$title', message: '$message', cc: '$cc', enableSigningOrder: '$enable_signing_order', expiryDateType: '$expiry_date_type',
  expiryValue: '$expiry_value', reminderSettings: '$reminder_settings', brandId: '$brand_id', labels: '$labels',
  disableEmails: '$disable_emails', onBehalfOf: '$on_behalf_of',
};

describe('boldsign adapter: static spec conformance', () => {
  it('sends the API key as X-API-KEY to the region host', () => {
    expect(a.slug).toBe('boldsign');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-signature');
    expect(a.icon).toBe('boldsign');
    expect(a.requiredEnvVars).toEqual(['BOLDSIGN_API_URL', 'BOLDSIGN_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{BOLDSIGN_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-KEY', apiKey: '{{BOLDSIGN_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/v1/document/list?Page=1&PageSize=1');
    expect(a.envVarMeta?.BOLDSIGN_API_KEY.secret).toBe(true);
    const url = new RegExp(a.envVarMeta?.BOLDSIGN_API_URL.pattern as string);
    for (const ok of ['https://api.boldsign.com', 'https://api-eu.boldsign.com', 'https://api-ca.boldsign.com', 'https://api-au.boldsign.com']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://api.boldsign.com/', 'https://app.boldsign.com', 'https://api-eu.boldsign.com/v1', 'api.boldsign.com']) expect(url.test(bad)).toBe(false);
  });

  it('maps the document reads to the documented routes and PascalCase list filters', () => {
    expect(tool(`${P}list_documents`).endpointMapping).toEqual({ method: 'GET', path: '/v1/document/list', queryParams: { ...PAGE, ...DOC_FILTERS, SentBy: '$sent_by', Recipients: '$recipients' } });
    expect(tool(`${P}list_documents`).parameters?.properties?.page.default).toBe(1);
    expect(tool(`${P}list_documents`).parameters?.properties?.status.items?.enum).toEqual(['None', 'WaitingForMe', 'WaitingForOthers', 'NeedAttention', 'Completed', 'Declined', 'Revoked', 'Expired', 'Draft', 'Scheduled']);
    expect(tool(`${P}list_team_documents`).endpointMapping).toEqual({ method: 'GET', path: '/v1/document/teamlist', queryParams: { ...PAGE, ...DOC_FILTERS, TeamId: '$team_ids', UserId: '$user_ids' } });
    expect(tool(`${P}list_behalf_documents`).endpointMapping).toMatchObject({ method: 'GET', path: '/v1/document/behalfList', queryParams: { ...PAGE, PageType: '$page_type', EmailAddress: '$sender_emails', Signers: '$signers' } });
    expect(tool(`${P}get_document`).endpointMapping).toEqual({ method: 'GET', path: '/v1/document/properties', queryParams: { documentId: '$document_id' } });
    expect(tool(`${P}download_document`).endpointMapping).toEqual({ method: 'GET', path: '/v1/document/download', queryParams: { documentId: '$document_id', format: '$format', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}download_audit_log`).endpointMapping).toEqual({ method: 'GET', path: '/v1/document/downloadAuditLog', queryParams: { documentId: '$document_id', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}get_embedded_sign_link`).endpointMapping).toEqual({
      method: 'GET',
      path: '/v1/document/getEmbeddedSignLink',
      queryParams: { DocumentId: '$document_id', SignerEmail: '$signer_email', CountryCode: '$country_code', PhoneNumber: '$phone_number', SignLinkValidTill: '$sign_link_valid_till', RedirectUrl: '$redirect_url' },
    });
  });

  it('maps templates, sender identities, contacts, teams, users, brands and credits', () => {
    expect(tool(`${P}list_templates`).endpointMapping).toMatchObject({ method: 'GET', path: '/v1/template/list', queryParams: { ...PAGE, SearchKey: '$search', TemplateType: '$template_type' } });
    expect(tool(`${P}get_template`).endpointMapping).toEqual({ method: 'GET', path: '/v1/template/properties', queryParams: { templateId: '$template_id' } });
    expect(tool(`${P}list_sender_identities`).endpointMapping).toEqual({ method: 'GET', path: '/v1/senderIdentities/list', queryParams: { ...PAGE, Search: '$search', BrandIds: '$brand_ids' } });
    expect(tool(`${P}get_sender_identity`).endpointMapping).toEqual({ method: 'GET', path: '/v1/senderIdentities/properties', queryParams: { id: '$id', email: '$email' } });
    expect(tool(`${P}list_contacts`).endpointMapping).toEqual({ method: 'GET', path: '/v1/contacts/list', queryParams: { ...PAGE, SearchKey: '$search', ContactType: '$contact_type' } });
    expect(tool(`${P}get_contact`).endpointMapping).toEqual({ method: 'GET', path: '/v1/contacts/get', queryParams: { id: '$contact_id' } });
    expect(tool(`${P}list_teams`).endpointMapping).toEqual({ method: 'GET', path: '/v1/teams/list', queryParams: { ...PAGE, SearchKey: '$search' } });
    expect(tool(`${P}get_team`).endpointMapping).toEqual({ method: 'GET', path: '/v1/teams/get', queryParams: { teamId: '$team_id' } });
    expect(tool(`${P}list_users`).endpointMapping).toEqual({ method: 'GET', path: '/v1/users/list', queryParams: { ...PAGE, Search: '$search', UserId: '$user_ids' } });
    expect(tool(`${P}get_user`).endpointMapping).toEqual({ method: 'GET', path: '/v1/users/get', queryParams: { userId: '$user_id' } });
    expect(tool(`${P}list_brands`).endpointMapping).toEqual({ method: 'GET', path: '/v1/brand/list' });
    expect(tool(`${P}get_brand`).endpointMapping).toEqual({ method: 'GET', path: '/v1/brand/get', queryParams: { brandId: '$brand_id' } });
    expect(tool(`${P}get_api_credits`).endpointMapping).toEqual({ method: 'GET', path: '/v1/plan/apiCreditsCount' });
  });

  it('maps sending and follow-up with documentId in the query and camelCase bodies', () => {
    expect(tool(`${P}send_document`).endpointMapping).toEqual({
      method: 'POST',
      path: '/v1/document/send',
      bodyMapping: { ...SEND, signers: '$signers', fileUrls: '$file_urls', files: '$files', useTextTags: '$use_text_tags', textTagDefinitions: '$text_tag_definitions', AutoDetectFields: '$auto_detect_fields', metaData: '$meta_data' },
    });
    expect(tool(`${P}send_from_template`).endpointMapping).toEqual({ method: 'POST', path: '/v1/template/send', queryParams: { templateId: '$template_id' }, bodyMapping: { ...SEND, roles: '$roles', roleRemovalIndices: '$role_removal_indices' } });
    expect(tool(`${P}send_draft`).endpointMapping).toEqual({ method: 'POST', path: '/v1/document/draftSend', queryParams: { documentId: '$document_id' } });
    expect(tool(`${P}remind_document`).endpointMapping).toEqual({ method: 'POST', path: '/v1/document/remind', queryParams: { documentId: '$document_id', receiverEmails: '$receiver_emails' }, bodyMapping: { message: '$message', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}revoke_document`).endpointMapping).toEqual({ method: 'POST', path: '/v1/document/revoke', queryParams: { documentId: '$document_id' }, bodyMapping: { message: '$message', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}revoke_document`).parameters?.required).toEqual(['document_id', 'message']);
    expect(tool(`${P}delete_document`).endpointMapping).toEqual({ method: 'DELETE', path: '/v1/document/delete', queryParams: { documentId: '$document_id', deletePermanently: '$delete_permanently' } });
    expect(tool(`${P}extend_expiry`).endpointMapping).toEqual({ method: 'PATCH', path: '/v1/document/extendExpiry', queryParams: { documentId: '$document_id' }, bodyMapping: { newExpiryValue: '$new_expiry_value', warnPrior: '$warn_prior', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}change_recipient`).endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/document/changeRecipient', bodyMapping: { newSignerName: '$new_signer_name', reason: '$reason' } });
    expect(tool(`${P}prefill_fields`).endpointMapping).toEqual({ method: 'PATCH', path: '/v1/document/prefillFields', queryParams: { documentId: '$document_id' }, bodyMapping: { fields: '$fields', onBehalfOf: '$on_behalf_of' } });
    expect(tool(`${P}create_contacts`).endpointMapping).toEqual({ method: 'POST', path: '/v1/contacts/create', bodyMapping: { __raw: '$contacts' } });
    expect(tool(`${P}update_contact`).endpointMapping).toMatchObject({ method: 'PUT', path: '/v1/contacts/update', queryParams: { id: '$contact_id' } });
    expect(tool(`${P}create_sender_identity`).endpointMapping).toMatchObject({ method: 'POST', path: '/v1/senderIdentities/create', bodyMapping: { email: '$email', name: '$name' } });
  });

  it('drops per-signer form fields and settings from document lists', () => {
    const out = applyResponseTransform(
      { pageDetails: { page: 1, totalPages: 1 }, result: [{ documentId: 'd1', status: 'InProgress', signerDetails: [{ signerEmail: 'a@b.c', status: 'NotCompleted', formFields: [{ id: 'f' }], authenticationSettings: {}, recipientNotificationSettings: {} }] }] },
      tool(`${P}list_documents`).responseMapping as never,
    ).value;
    expect(out).toEqual({ pageDetails: { page: 1, totalPages: 1 }, result: [{ documentId: 'd1', status: 'InProgress', signerDetails: [{ signerEmail: 'a@b.c', status: 'NotCompleted' }] }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and required ids are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(P)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const id of ['document_id', 'template_id', 'contact_id', 'team_id', 'user_id', 'brand_id']) {
        if (Object.values(t.endpointMapping.queryParams ?? {}).includes(`$${id}`)) expect(`${t.name}:${t.parameters?.required?.includes(id)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('reads stay on GET; every write is annotated and changes are destructive', () => {
    for (const t of a.tools) {
      const off = ['boldsign_revoke_document', 'boldsign_delete_document'].includes(t.name);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${off ? false : undefined}`);
      if (READS.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
        expect(t.annotations).toBeUndefined();
      } else {
        expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
        if (['PUT', 'PATCH', 'DELETE'].includes(t.endpointMapping.method)) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      }
    }
    expect(tool(`${P}revoke_document`).annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: `${P}list_documents`, params: { page: 1, page_size: 1 } });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_BOLDSIGN_LIVE === '1' && process.env.BOLDSIGN_API_KEY ? describe : describe.skip;
live('boldsign adapter: live (read-only)', () => {
  const base = process.env.BOLDSIGN_API_URL || 'https://api.boldsign.com';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-API-KEY': process.env.BOLDSIGN_API_KEY as string, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { result: Array<{ documentId?: string }>; pageDetails?: unknown };
  };
  it('reads documents, templates, contacts, brands and one document', async () => {
    const docs = await get('/v1/document/list?Page=1&PageSize=2');
    expect(Array.isArray(docs.result)).toBe(true);
    expect(docs.pageDetails).toBeDefined();
    expect(Array.isArray((await get('/v1/template/list?Page=1&PageSize=2')).result)).toBe(true);
    expect(Array.isArray((await get('/v1/contacts/list?Page=1&PageSize=2')).result)).toBe(true);
    await get('/v1/brand/list');
    const first = docs.result[0]?.documentId;
    if (first) expect((await get(`/v1/document/properties?documentId=${first}`)) as unknown).toMatchObject({ documentId: first });
  }, 60_000);
});
