import * as adapter from './docuseal.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * DocuSeal API (docuseal.com/docs/api, OpenAPI at console.docuseal.com/openapi.json and
 * github.com/docusealco/docuseal docs/openapi.json; the completed-event routes come from
 * the open-source config/routes.rb): X-Auth-Token header, base https://api.docuseal.com,
 * https://api.docuseal.eu or https://<host>/api when self-hosted.
 * Live part (reads only: templates, submissions, submitters, completed events):
 *   DOCUSEAL_API_KEY=... [DOCUSEAL_API_URL=https://api.docuseal.eu] RUN_DOCUSEAL_LIVE=1 npx jest src/adapters/intl/docuseal
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string; default?: unknown }>; required?: string[] };
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
const P = 'docuseal_';
const READS = [
  'list_templates', 'get_template', 'list_submissions', 'get_submission', 'get_submission_documents',
  'list_submitters', 'get_submitter', 'list_form_completed_events', 'list_submission_completed_events',
].map((n) => `${P}${n}`);
const PAGE = { limit: '$limit', after: '$after', before: '$before' };
const SEND = { send_email: '$send_email', send_sms: '$send_sms', order: '$order', completed_redirect_url: '$completed_redirect_url', bcc_completed: '$bcc_completed', reply_to: '$reply_to', expire_at: '$expire_at', message: '$message' };

describe('docuseal adapter: static spec conformance', () => {
  it('sends the API key as X-Auth-Token to the Cloud, EU or self-hosted address', () => {
    expect(a.slug).toBe('docuseal');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-signature');
    expect(a.icon).toBe('docuseal');
    expect(a.requiredEnvVars).toEqual(['DOCUSEAL_API_URL', 'DOCUSEAL_API_KEY']);
    expect(a.connector.baseUrl).toBe('{{DOCUSEAL_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Auth-Token', apiKey: '{{DOCUSEAL_API_KEY}}' });
    expect(a.envVarMeta?.DOCUSEAL_API_KEY.secret).toBe(true);
    const url = new RegExp(a.envVarMeta?.DOCUSEAL_API_URL.pattern as string);
    for (const ok of ['https://api.docuseal.com', 'https://api.docuseal.eu', 'https://sign.example.com/api', 'http://10.0.0.5:3000/api']) expect(url.test(ok)).toBe(true);
    for (const bad of ['https://api.docuseal.com/', 'api.docuseal.com', 'https://sign.example.com/api/']) expect(url.test(bad)).toBe(false);
  });

  it('maps the reads to the documented routes and query names', () => {
    expect(tool(`${P}list_templates`).endpointMapping).toEqual({ method: 'GET', path: '/templates', queryParams: { q: '$q', slug: '$slug', external_id: '$external_id', folder: '$folder', archived: '$archived', ...PAGE } });
    expect(tool(`${P}get_template`).endpointMapping).toEqual({ method: 'GET', path: '/templates/{template_id}' });
    expect(tool(`${P}list_submissions`).endpointMapping).toEqual({
      method: 'GET',
      path: '/submissions',
      queryParams: { template_id: '$template_id', status: '$status', q: '$q', slug: '$slug', template_folder: '$template_folder', archived: '$archived', ...PAGE },
    });
    expect(tool(`${P}list_submissions`).parameters?.properties?.status.enum).toEqual(['pending', 'completed', 'declined', 'expired']);
    expect(tool(`${P}get_submission`).endpointMapping).toEqual({ method: 'GET', path: '/submissions/{submission_id}' });
    expect(tool(`${P}get_submission_documents`).endpointMapping).toEqual({ method: 'GET', path: '/submissions/{submission_id}/documents', queryParams: { merge: '$merge' } });
    expect(tool(`${P}list_submitters`).endpointMapping).toEqual({
      method: 'GET',
      path: '/submitters',
      queryParams: { submission_id: '$submission_id', q: '$q', slug: '$slug', external_id: '$external_id', completed_after: '$completed_after', completed_before: '$completed_before', ...PAGE },
    });
    expect(tool(`${P}get_submitter`).endpointMapping).toEqual({ method: 'GET', path: '/submitters/{submitter_id}' });
    expect(tool(`${P}list_form_completed_events`).endpointMapping).toEqual({ method: 'GET', path: '/events/form/completed', queryParams: PAGE });
    expect(tool(`${P}list_submission_completed_events`).endpointMapping).toEqual({ method: 'GET', path: '/events/submission/completed', queryParams: PAGE });
  });

  it('maps submission writes with the documented snake_case body fields', () => {
    expect(tool(`${P}create_submission`).endpointMapping).toEqual({ method: 'POST', path: '/submissions', bodyMapping: { template_id: '$template_id', submitters: '$submitters', ...SEND, variables: '$variables' } });
    expect(tool(`${P}create_submission`).parameters?.required).toEqual(['template_id', 'submitters']);
    expect(tool(`${P}create_submission`).parameters?.properties?.order.enum).toEqual(['preserved', 'random']);
    expect(tool(`${P}create_submissions_from_emails`).endpointMapping).toEqual({ method: 'POST', path: '/submissions/emails', bodyMapping: { template_id: '$template_id', emails: '$emails', send_email: '$send_email', message: '$message' } });
    expect(tool(`${P}create_submission_from_pdf`).endpointMapping).toEqual({
      method: 'POST',
      path: '/submissions/pdf',
      bodyMapping: { name: '$name', documents: '$documents', submitters: '$submitters', ...SEND, flatten: '$flatten', merge_documents: '$merge_documents', remove_tags: '$remove_tags' },
    });
    expect(tool(`${P}update_submission`).endpointMapping).toEqual({ method: 'PUT', path: '/submissions/{submission_id}', bodyMapping: { name: '$name', expire_at: '$expire_at', archived: '$archived' } });
    expect(tool(`${P}archive_submission`).endpointMapping).toEqual({ method: 'DELETE', path: '/submissions/{submission_id}' });
    expect(tool(`${P}update_submitter`).endpointMapping).toMatchObject({ method: 'PUT', path: '/submitters/{submitter_id}', bodyMapping: { email: '$email', values: '$values', send_email: '$send_email', completed: '$completed', fields: '$fields' } });
  });

  it('maps template creation from PDF, DOCX and HTML, clone, update and archive', () => {
    expect(tool(`${P}create_template_from_pdf`).endpointMapping).toEqual({
      method: 'POST',
      path: '/templates/pdf',
      bodyMapping: { name: '$name', documents: '$documents', folder_name: '$folder_name', external_id: '$external_id', shared_link: '$shared_link', flatten: '$flatten', remove_tags: '$remove_tags' },
    });
    expect(tool(`${P}create_template_from_docx`).endpointMapping).toMatchObject({ method: 'POST', path: '/templates/docx', bodyMapping: { documents: '$documents' } });
    expect(tool(`${P}create_template_from_html`).endpointMapping).toMatchObject({ method: 'POST', path: '/templates/html', bodyMapping: { html: '$html', html_header: '$html_header', html_footer: '$html_footer', size: '$size' } });
    expect(tool(`${P}clone_template`).endpointMapping).toEqual({ method: 'POST', path: '/templates/{template_id}/clone', bodyMapping: { name: '$name', folder_name: '$folder_name', external_id: '$external_id' } });
    expect(tool(`${P}update_template`).endpointMapping).toEqual({ method: 'PUT', path: '/templates/{template_id}', bodyMapping: { name: '$name', folder_name: '$folder_name', roles: '$roles', archived: '$archived' } });
    expect(tool(`${P}archive_template`).endpointMapping).toEqual({ method: 'DELETE', path: '/templates/{template_id}' });
  });

  it('drops field areas and preview images from template lists', () => {
    const out = applyResponseTransform(
      { data: [{ id: 1, name: 'NDA', fields: [{ name: 'Sign', type: 'signature', areas: [{ x: 0.1 }] }], documents: [{ id: 2, url: 'u', preview_image_url: 'p' }] }], pagination: { next: 1 } },
      tool(`${P}list_templates`).responseMapping as never,
    ).value;
    expect(out).toEqual({ data: [{ id: 1, name: 'NDA', fields: [{ name: 'Sign', type: 'signature' }], documents: [{ id: 2, url: 'u' }] }], pagination: { next: 1 } });
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
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (READS.includes(t.name)) {
        expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
        expect(t.annotations).toBeUndefined();
      } else {
        expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:false`);
        if (['PUT', 'DELETE'].includes(t.endpointMapping.method)) expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: `${P}list_templates`, params: { limit: 1 } });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_DOCUSEAL_LIVE === '1' && process.env.DOCUSEAL_API_KEY ? describe : describe.skip;
live('docuseal adapter: live (read-only)', () => {
  const base = process.env.DOCUSEAL_API_URL || 'https://api.docuseal.com';
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-Auth-Token': process.env.DOCUSEAL_API_KEY as string, Accept: 'application/json' } });
    expect(`${path}:${res.status}`).toBe(`${path}:200`);
    return (await res.json()) as { data: Array<{ id: number }>; pagination: unknown };
  };
  it('reads templates, submissions, submitters and completed events', async () => {
    const templates = await get('/templates?limit=2');
    expect(Array.isArray(templates.data)).toBe(true);
    expect(templates.pagination).toBeDefined();
    if (templates.data[0]) expect((await get(`/templates/${templates.data[0].id}`)) as unknown).toMatchObject({ id: templates.data[0].id });
    const submissions = await get('/submissions?limit=2');
    expect(Array.isArray(submissions.data)).toBe(true);
    expect(Array.isArray((await get('/submitters?limit=2')).data)).toBe(true);
    expect(Array.isArray((await get('/events/submission/completed?limit=2')).data)).toBe(true);
  }, 60_000);
});
