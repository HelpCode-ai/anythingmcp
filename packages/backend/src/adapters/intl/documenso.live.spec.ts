import * as adapter from './documenso.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Documenso API v2, envelope API (docs.documenso.com/docs/developers/api, OpenAPI at
 * https://app.documenso.com/api/v2/openapi.json, migration guide at
 * docs.documenso.com/docs/developers/api/migrate-to-envelopes): the team API token goes as is
 * in the Authorization header; base https://app.documenso.com/api/v2 or https://<host>/api/v2.
 * Live part (reads only: envelopes, folders, one envelope, its audit log):
 *   DOCUMENSO_API_KEY=... [DOCUMENSO_API_URL=https://sign.example.com/api/v2] RUN_DOCUMENSO_LIVE=1 npx jest src/adapters/intl/documenso
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; bodyEncoding?: string; headers?: Record<string, unknown> };
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
const P = 'documenso_';
const READS = [
  'list_envelopes', 'get_envelope', 'get_envelope_audit_log', 'download_document', 'download_audit_log_pdf',
  'download_certificate', 'get_recipient', 'get_field', 'list_folders',
].map((n) => `${P}${n}`);
const PAGE = { page: '$page', perPage: '$per_page' };
const META = { subject: '$subject', message: '$message', distributionMethod: '$distribution_method', redirectUrl: '$redirect_url', language: '$language' };

describe('documenso adapter: static spec conformance', () => {
  it('sends the team token unprefixed in Authorization to the Cloud or self-hosted /api/v2', () => {
    expect(a.slug).toBe('documenso');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-signature');
    expect(a.icon).toBe('documenso');
    expect(a.requiredEnvVars).toEqual(['DOCUMENSO_API_URL', 'DOCUMENSO_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{DOCUMENSO_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: '{{DOCUMENSO_API_KEY}}' });
    expect(a.connector.healthcheckPath).toBe('/envelope?perPage=1');
    expect(a.envVarMeta?.DOCUMENSO_API_KEY.secret).toBe(true);
    const key = new RegExp(a.envVarMeta?.DOCUMENSO_API_KEY.pattern as string);
    expect(key.test('api_abcdefgh12345678')).toBe(true);
    expect(key.test('Bearer api_abcdefgh12345678')).toBe(false);
    const url = new RegExp(a.envVarMeta?.DOCUMENSO_API_URL.pattern as string);
    for (const ok of ['https://app.documenso.com/api/v2', 'https://sign.example.com/api/v2', 'http://10.0.0.5:3000/api/v2']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://app.documenso.com', 'https://app.documenso.com/api/v2/', 'https://app.documenso.com/api/v1', 'app.documenso.com/api/v2']) expect(url.test(bad)).toBe(false);
  });

  it('maps the reads to the documented envelope routes and camelCase query names', () => {
    expect(tool(`${P}list_envelopes`).endpointMapping).toEqual({
      method: 'GET',
      path: '/envelope',
      queryParams: { query: '$query', type: '$type', status: '$status', templateId: '$template_id', source: '$source', hasExpiredRecipients: '$has_expired_recipients', folderId: '$folder_id', orderByDirection: '$order_direction', ...PAGE },
    });
    expect(tool(`${P}list_envelopes`).parameters?.properties?.status.enum).toEqual(['DRAFT', 'PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']);
    expect(tool(`${P}get_envelope`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/{envelope_id}' });
    expect(tool(`${P}get_envelope_audit_log`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/{envelope_id}/audit-log', queryParams: { orderByDirection: '$order_direction', ...PAGE } });
    expect(tool(`${P}download_document`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/item/{envelope_item_id}/download', queryParams: { version: '$version' } });
    expect(tool(`${P}download_document`).parameters?.properties?.version.enum).toEqual(['signed', 'original', 'pending']);
    expect(tool(`${P}download_audit_log_pdf`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/{envelope_id}/audit-log/download' });
    expect(tool(`${P}download_certificate`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/{envelope_id}/certificate/download' });
    expect(tool(`${P}get_recipient`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/recipient/{recipient_id}' });
    expect(tool(`${P}get_field`).endpointMapping).toEqual({ method: 'GET', path: '/envelope/field/{field_id}' });
    expect(tool(`${P}list_folders`).endpointMapping).toEqual({ method: 'GET', path: '/folder', queryParams: { query: '$query', type: '$type', parentId: '$parent_id', ...PAGE } });
  });

  it('creates envelopes and uses templates as multipart with a JSON payload part', () => {
    const create = tool(`${P}create_envelope`).endpointMapping;
    expect(create).toEqual({
      method: 'POST',
      path: '/envelope/create',
      bodyEncoding: 'form-data',
      bodyMapping: {
        payload: { __json: { title: '$title', type: '$type', externalId: '$external_id', folderId: '$folder_id', recipients: '$recipients', formValues: '$form_values', meta: { ...META, signingOrder: '$signing_order' } } },
        files: { __file: '$file_url' },
      },
    });
    expect(tool(`${P}create_envelope`).parameters?.required).toEqual(['title', 'type', 'file_url']);
    expect(tool(`${P}use_template`).endpointMapping).toEqual({
      method: 'POST',
      path: '/envelope/use',
      bodyEncoding: 'form-data',
      bodyMapping: {
        payload: {
          __json: {
            envelopeId: '$template_envelope_id', recipients: '$recipients', distributeDocument: '$distribute', externalId: '$external_id', folderId: '$folder_id', prefillFields: '$prefill_fields', formValues: '$form_values',
            override: { title: '$title', ...META },
          },
        },
      },
    });
  });

  it('maps sending, follow-up and editing to the documented JSON bodies', () => {
    expect(tool(`${P}distribute_envelope`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/distribute', bodyMapping: { envelopeId: '$envelope_id', meta: META } });
    expect(tool(`${P}redistribute_envelope`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/redistribute', bodyMapping: { envelopeId: '$envelope_id', recipients: '$recipient_ids' } });
    expect(tool(`${P}cancel_envelope`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/cancel', bodyMapping: { envelopeId: '$envelope_id', reason: '$reason' } });
    expect(tool(`${P}delete_envelope`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/delete', bodyMapping: { envelopeId: '$envelope_id' } });
    expect(tool(`${P}update_envelope`).endpointMapping).toEqual({
      method: 'POST',
      path: '/envelope/update',
      bodyMapping: { envelopeId: '$envelope_id', data: { title: '$title', externalId: '$external_id', folderId: '$folder_id', visibility: '$visibility' }, meta: { ...META, signingOrder: '$signing_order', timezone: '$timezone' } },
    });
    expect(tool(`${P}duplicate_envelope`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/duplicate', bodyMapping: { envelopeId: '$envelope_id', includeRecipients: '$include_recipients', includeFields: '$include_fields' } });
    expect(tool(`${P}add_recipients`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/recipient/create-many', bodyMapping: { envelopeId: '$envelope_id', data: '$recipients' } });
    expect(tool(`${P}update_recipients`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/recipient/update-many', bodyMapping: { envelopeId: '$envelope_id', data: '$recipients' } });
    expect(tool(`${P}delete_recipient`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/recipient/delete', bodyMapping: { recipientId: '$recipient_id' } });
    expect(tool(`${P}add_fields`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/field/create-many', bodyMapping: { envelopeId: '$envelope_id', data: '$fields' } });
    expect(tool(`${P}delete_field`).endpointMapping).toEqual({ method: 'POST', path: '/envelope/field/delete', bodyMapping: { fieldId: '$field_id' } });
  });

  it('drops signing tokens, team and auth options from envelope lists', () => {
    const out = applyResponseTransform(
      { data: [{ id: 'envelope_1', title: 'NDA', team: { id: 1, url: 't' }, authOptions: {}, recipients: [{ id: 3, email: 'a@b.c', token: 'secret', signingStatus: 'SIGNED' }] }], count: 1, totalPages: 1 },
      tool(`${P}list_envelopes`).responseMapping as never,
    ).value;
    expect(out).toEqual({ data: [{ id: 'envelope_1', title: 'NDA', recipients: [{ id: 3, email: 'a@b.c', signingStatus: 'SIGNED' }] }], count: 1, totalPages: 1 });
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

  it('reads stay on GET; every write is annotated and changes are destructive', () => {
    for (const t of a.tools) {
      const off = ['documenso_cancel_envelope', 'documenso_delete_envelope', 'documenso_delete_recipient', 'documenso_delete_field'].includes(t.name);
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:${off ? false : undefined}`);
      if (READS.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
        expect(t.annotations).toBeUndefined();
      } else {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:POST`);
        expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
      }
    }
    for (const n of ['cancel_envelope', 'delete_envelope', 'update_envelope', 'update_recipients', 'delete_recipient', 'delete_field']) expect(tool(`${P}${n}`).annotations?.destructiveHint).toBe(true);
    for (const n of ['create_envelope', 'use_template', 'distribute_envelope', 'add_recipients', 'add_fields']) expect(tool(`${P}${n}`).annotations?.destructiveHint).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: `${P}list_envelopes`, params: { per_page: 1 } });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_DOCUMENSO_LIVE === '1' && process.env.DOCUMENSO_API_KEY ? describe : describe.skip;
live('documenso adapter: live (read-only)', () => {
  const base = process.env.DOCUMENSO_API_URL || 'https://app.documenso.com/api/v2';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: process.env.DOCUMENSO_API_KEY as string, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { data: Array<{ id: string }>; totalPages: number };
  };
  it('reads envelopes, folders, one envelope and its audit log', async () => {
    const envelopes = await get('/envelope?perPage=2');
    expect(Array.isArray(envelopes.data)).toBe(true);
    expect(typeof envelopes.totalPages).toBe('number');
    expect(Array.isArray((await get('/folder?perPage=2')).data)).toBe(true);
    const first = envelopes.data[0];
    if (first) {
      expect((await get(`/envelope/${first.id}`)) as unknown).toMatchObject({ id: first.id });
      expect(Array.isArray((await get(`/envelope/${first.id}/audit-log?perPage=2`)).data)).toBe(true);
    }
  }, 60_000);
});
