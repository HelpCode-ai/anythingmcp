import * as adapter from './signnow.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * signNow REST API (docs.signnow.com/docs/signnow/welcome, authentication at
 * docs.signnow.com/docs/signnow/authentication; routes cross-checked with the official
 * github.com/signnow/SignNowNodeSDK, github.com/signnow/sn-mcp-server and github.com/signnow/postman-collection):
 * API key as Bearer token, base https://api.signnow.com. A wrong key answers 400 invalid_token (code 1537).
 * Live part (reads only: user, folders, one folder, one document):
 *   SIGNNOW_API_KEY=... RUN_SIGNNOW_LIVE=1 npx jest src/adapters/intl/signnow
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
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
  verifyHints?: Record<string, string>;
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
const P = 'signnow_';
const GET_READS = [
  'get_user', 'list_folders', 'get_folder', 'get_document', 'get_document_fields', 'get_document_history', 'list_free_form_invites',
  'get_routing_details', 'download_document', 'list_document_groups', 'get_document_group', 'get_document_group_recipients',
  'get_group_invite', 'list_template_groups', 'get_template_group',
].map((n) => `${P}${n}`);
const POST_READS = ['get_download_link', 'download_document_group'].map((n) => `${P}${n}`);

describe('signnow adapter: static spec conformance', () => {
  it('sends the API key as a Bearer token to api.signnow.com', () => {
    expect(a.slug).toBe('signnow');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-signature');
    expect(a.icon).toBe('signnow');
    expect(a.requiredEnvVars).toEqual(['SIGNNOW_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.signnow.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SIGNNOW_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/user');
    expect(a.envVarMeta?.SIGNNOW_API_KEY.secret).toBe(true);
    const key = new RegExp(a.envVarMeta?.SIGNNOW_API_KEY.pattern as string);
    expect(key.test('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(true);
    expect(key.test('Bearer 0123456789abcdef0123456789abcdef')).toBe(false);
    expect(a.verifyHints?.['400']).toMatch(/1537/);
  });

  it('maps user, folders and document reads to the documented routes', () => {
    expect(tool(`${P}get_user`).endpointMapping).toEqual({ method: 'GET', path: '/user' });
    expect(tool(`${P}list_folders`).endpointMapping).toEqual({ method: 'GET', path: '/user/folder', queryParams: { entity_type: '$entity_type', with_team_documents: '$with_team_documents' } });
    expect(tool(`${P}get_folder`).endpointMapping).toEqual({
      method: 'GET',
      path: '/folder/{folder_id}',
      queryParams: {
        entity_type: '$entity_type', filters: '$filters', 'filter-values': '$filter_values', sortby: '$sortby', order: '$order', limit: '$limit',
        offset: '$offset', include_documents_subfolders: '$include_documents_subfolders', with_team_documents: '$with_team_documents',
      },
    });
    expect(tool(`${P}get_folder`).parameters?.properties?.filters.enum).toEqual(['signing-status', 'documents-created', 'documents-updated']);
    expect(tool(`${P}get_document`).endpointMapping).toEqual({ method: 'GET', path: '/document/{document_id}' });
    expect(tool(`${P}get_document_fields`).endpointMapping).toEqual({ method: 'GET', path: '/v2/documents/{document_id}/fields' });
    expect(tool(`${P}get_document_history`).endpointMapping).toEqual({ method: 'GET', path: '/document/{document_id}/historyfull' });
    expect(tool(`${P}list_free_form_invites`).endpointMapping).toEqual({ method: 'GET', path: '/v2/documents/{document_id}/free-form-invites', queryParams: { page: '$page', per_page: '$per_page' } });
    expect(tool(`${P}get_routing_details`).endpointMapping).toEqual({ method: 'GET', path: '/document/{template_id}/template/routing/detail' });
    expect(tool(`${P}download_document`).endpointMapping).toEqual({ method: 'GET', path: '/document/{document_id}/download', queryParams: { type: '$type', with_history: '$with_history' } });
    expect(tool(`${P}get_download_link`).endpointMapping).toEqual({ method: 'POST', path: '/document/{document_id}/download/link' });
  });

  it('maps document groups and group templates', () => {
    expect(tool(`${P}list_document_groups`).endpointMapping).toEqual({ method: 'GET', path: '/user/documentgroups', queryParams: { limit: '$limit', offset: '$offset' } });
    expect(tool(`${P}get_document_group`).endpointMapping).toEqual({ method: 'GET', path: '/documentgroup/{document_group_id}' });
    expect(tool(`${P}get_document_group_recipients`).endpointMapping).toEqual({ method: 'GET', path: '/v2/document-groups/{document_group_id}/recipients' });
    expect(tool(`${P}get_group_invite`).endpointMapping).toEqual({ method: 'GET', path: '/documentgroup/{document_group_id}/groupinvite/{invite_id}' });
    expect(tool(`${P}list_template_groups`).endpointMapping).toEqual({ method: 'GET', path: '/user/documentgroup/templates', queryParams: { limit: '$limit', offset: '$offset' } });
    expect(tool(`${P}get_template_group`).endpointMapping).toEqual({ method: 'GET', path: '/documentgroup/template/{template_group_id}' });
    expect(tool(`${P}download_document_group`).endpointMapping).toEqual({ method: 'POST', path: '/documentgroup/{document_group_id}/downloadall', bodyMapping: { type: '$type', with_history: '$with_history', document_order: '$document_order' } });
    expect(tool(`${P}create_document_group`).endpointMapping).toEqual({ method: 'POST', path: '/documentgroup', bodyMapping: { document_ids: '$document_ids', group_name: '$group_name' } });
    expect(tool(`${P}create_group_from_template`).endpointMapping).toEqual({ method: 'POST', path: '/v2/document-group-templates/{template_group_id}/document-group', bodyMapping: { group_name: '$group_name', folder_id: '$folder_id' } });
    expect(tool(`${P}send_group_invite`).endpointMapping).toEqual({ method: 'POST', path: '/documentgroup/{document_group_id}/groupinvite', bodyMapping: { invite_steps: '$invite_steps', completion_emails: '$completion_emails', cc: '$cc', sign_as_merged: '$sign_as_merged' } });
    expect(tool(`${P}resend_group_invite`).endpointMapping).toEqual({ method: 'POST', path: '/documentgroup/{document_group_id}/groupinvite/{invite_id}/resendinvites', bodyMapping: { email: '$email' } });
    expect(tool(`${P}cancel_group_invite`).endpointMapping).toEqual({ method: 'POST', path: '/documentgroup/{document_group_id}/groupinvite/{invite_id}/cancelinvite', bodyMapping: {} });
    expect(tool(`${P}delete_document_group`).endpointMapping).toEqual({ method: 'DELETE', path: '/documentgroup/{document_group_id}' });
  });

  it('maps document writes and invites with the documented snake_case bodies', () => {
    expect(tool(`${P}upload_document_from_url`).endpointMapping).toEqual({ method: 'POST', path: '/v2/documents/url', bodyMapping: { url: '$url', name: '$name', check_fields: '$check_fields', make_template: '$make_template' } });
    expect(tool(`${P}update_document`).endpointMapping).toEqual({ method: 'PUT', path: '/document/{document_id}', bodyMapping: { document_name: '$document_name', fields: '$fields' } });
    expect(tool(`${P}create_template`).endpointMapping).toEqual({ method: 'POST', path: '/template', bodyMapping: { document_id: '$document_id', document_name: '$document_name' } });
    expect(tool(`${P}create_document_from_template`).endpointMapping).toEqual({ method: 'POST', path: '/template/{template_id}/copy', bodyMapping: { document_name: '$document_name', folder_id: '$folder_id' } });
    expect(tool(`${P}send_invite`).endpointMapping).toEqual({
      method: 'POST',
      path: '/document/{document_id}/invite',
      bodyMapping: { document_id: '$document_id', to: '$to', from: '$from', cc: '$cc', subject: '$subject', message: '$message', cc_subject: '$cc_subject', cc_message: '$cc_message' },
    });
    expect(tool(`${P}send_invite`).parameters?.required).toEqual(['document_id', 'to', 'from']);
    expect(tool(`${P}send_free_form_invite`).endpointMapping).toMatchObject({ method: 'POST', path: '/document/{document_id}/invite', bodyMapping: { document_id: '$document_id', to: '$to', from: '$from' } });
    expect(tool(`${P}send_free_form_invite`).parameters?.properties?.to.type).toBe('string');
    expect(tool(`${P}cancel_invite`).endpointMapping).toEqual({ method: 'PUT', path: '/document/{document_id}/fieldinvitecancel', bodyMapping: { reason: '$reason' } });
    expect(tool(`${P}cancel_free_form_invite`).endpointMapping).toEqual({ method: 'PUT', path: '/invite/{invite_id}/cancel', bodyMapping: { reason: '$reason' } });
    expect(tool(`${P}resend_field_invite`).endpointMapping).toEqual({ method: 'PUT', path: '/fieldinvite/{field_invite_id}/resend', bodyMapping: {} });
    expect(tool(`${P}prefill_text_fields`).endpointMapping).toEqual({ method: 'PUT', path: '/v2/documents/{document_id}/prefill-texts', bodyMapping: { fields: '$fields' } });
    expect(tool(`${P}create_signing_link`).endpointMapping).toEqual({ method: 'POST', path: '/link', bodyMapping: { document_id: '$document_id', redirect_uri: '$redirect_uri' } });
    expect(tool(`${P}move_document`).endpointMapping).toEqual({ method: 'POST', path: '/document/{document_id}/move', bodyMapping: { folder_id: '$folder_id' } });
    expect(tool(`${P}delete_document`).endpointMapping).toEqual({ method: 'DELETE', path: '/document/{document_id}' });
    expect(tool(`${P}create_folder`).endpointMapping).toEqual({ method: 'POST', path: '/user/folder', bodyMapping: { name: '$name', parent_id: '$parent_id' } });
  });

  it('drops thumbnails, page images and signature image data from documents', () => {
    const out = applyResponseTransform(
      { id: 'd1', document_name: 'NDA', thumbnail: { small: 'u' }, pages: [{ src: 'p' }], originator_logo: 'l', signatures: [{ id: 's1', email: 'a@b.c', data: 'iVBOR...' }], field_invites: [{ id: 'f1', status: 'pending' }] },
      tool(`${P}get_document`).responseMapping as never,
    ).value;
    expect(out).toEqual({ id: 'd1', document_name: 'NDA', signatures: [{ id: 's1', email: 'a@b.c' }], field_invites: [{ id: 'f1', status: 'pending' }] });
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

  it('reads are GET or read-only POST; every write is annotated and changes are destructive', () => {
    for (const t of a.tools) {
      const off = ['signnow_delete_document', 'signnow_delete_document_group'].includes(t.name);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${off ? false : undefined}`);
      if (GET_READS.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
        expect(t.annotations).toBeUndefined();
      } else if (POST_READS.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:POST:true`);
      } else {
        expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
        // A PUT that only re-sends an invite email (a reminder) changes nothing.
        const reminder = t.name === `${P}resend_field_invite`;
        if (['PUT', 'PATCH', 'DELETE'].includes(t.endpointMapping.method)) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:${!reminder}`);
      }
    }
    for (const n of ['cancel_group_invite', 'move_document']) expect(tool(`${P}${n}`).annotations?.destructiveHint).toBe(true);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: `${P}get_user` });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_SIGNNOW_LIVE === '1' && process.env.SIGNNOW_API_KEY ? describe : describe.skip;
live('signnow adapter: live (read-only)', () => {
  const base = 'https://api.signnow.com';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${process.env.SIGNNOW_API_KEY}`, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the user, the folder tree, one folder and one document', async () => {
    expect(typeof (await get('/user')).id).toBe('string');
    const root = (await get('/user/folder')) as { id: string; folders: Array<{ id: string; name: string }> };
    expect(Array.isArray(root.folders)).toBe(true);
    const docsFolder = root.folders.find((f) => f.name === 'Documents') ?? root.folders[0];
    if (docsFolder) {
      const folder = (await get(`/folder/${docsFolder.id}?limit=2`)) as { documents: Array<{ id: string }> };
      expect(Array.isArray(folder.documents)).toBe(true);
      if (folder.documents[0]) expect((await get(`/document/${folder.documents[0].id}`)) as unknown).toMatchObject({ id: folder.documents[0].id });
    }
    expect(Array.isArray((await get('/user/documentgroups?limit=2')).document_groups ?? [])).toBe(true);
  }, 60_000);
});
