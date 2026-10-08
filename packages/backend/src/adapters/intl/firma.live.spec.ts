import * as adapter from './firma.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Firma.dev adapter.
 *
 *   1. Static — always runs: the key goes in `Authorization` with no Bearer
 *      prefix, every tool reaches the right path with the right body, the
 *      list view is trimmed, and the tools that email real people or spend a
 *      credit are not advertised as read-only.
 *
 *   2. Live — skipped unless RUN_FIRMA_LIVE is set. Reads only, so a test key
 *      is enough and nothing is sent or charged:
 *
 *        RUN_FIRMA_LIVE=1 FIRMA_API_KEY=<test key> \
 *          npx jest src/adapters/intl/firma.live.spec.ts
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
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping?: Record<string, string> };
  responseMapping?: { transform: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const engine = () =>
  new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const config = (key = 'firma_test_key') => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { ...a.connector.authConfig, apiKey: key },
});
const BASE = 'https://api.firma.dev/functions/v1/signing-request-api';

const call = async (name: string, params: Record<string, unknown>) => {
  mockedAxios.mockResolvedValue({ data: {} });
  await engine().execute(config(), tool(name).endpointMapping as any, params);
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
};

describe('firma adapter — static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the key as a bare Authorization header', async () => {
    expect(a.requiredEnvVars).toEqual(['FIRMA_API_KEY']);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'Authorization',
      apiKey: '{{FIRMA_API_KEY}}',
    });
    const req = await call('firma_get_company', {});
    expect(req.headers.Authorization).toBe('firma_test_key');
  });

  it.each([
    ['firma_get_company', {}, 'GET', '/company'],
    ['firma_list_templates', { name: 'NDA' }, 'GET', '/templates'],
    ['firma_get_template', { template_id: 't1' }, 'GET', '/templates/t1'],
    ['firma_list_template_recipients', { template_id: 't1' }, 'GET', '/templates/t1/users'],
    ['firma_list_signing_requests', { status: 'in_progress' }, 'GET', '/signing-requests'],
    ['firma_get_signing_request', { signing_request_id: 's1' }, 'GET', '/signing-requests/s1'],
    ['firma_list_signing_request_recipients', { signing_request_id: 's1' }, 'GET', '/signing-requests/s1/users'],
    ['firma_get_signing_request_audit', { signing_request_id: 's1' }, 'GET', '/signing-requests/s1/audit'],
    ['firma_get_signed_document_url', { signing_request_id: 's1' }, 'GET', '/signing-requests/s1/download'],
    ['firma_create_signing_request_from_template', { template_id: 't1' }, 'POST', '/signing-requests'],
    ['firma_send_signing_request', { signing_request_id: 's1' }, 'POST', '/signing-requests/s1/send'],
    ['firma_resend_signing_request', { signing_request_id: 's1', recipient_ids: ['u1'] }, 'POST', '/signing-requests/s1/resend'],
    ['firma_cancel_signing_request', { signing_request_id: 's1' }, 'POST', '/signing-requests/s1/cancel'],
  ])('%s calls %s %s', async (name, params, method, path) => {
    const req = await call(name, params);
    expect(req.method).toBe(method);
    expect(req.url).toBe(BASE + path);
  });

  it('covers every tool in the table above', () => {
    expect(a.tools).toHaveLength(13);
    expect(a.instructions).toContain('13 tools');
  });

  it('creates a draft from a template with the recipients in their slots', async () => {
    const recipients = [
      { template_user_id: 'slot-1', first_name: 'Ada', email: 'ada@example.com', designation: 'Signer' },
    ];
    const req = await call('firma_create_signing_request_from_template', {
      template_id: 't1',
      name: 'NDA - Acme',
      recipients,
      expiration_hours: 72,
    });
    expect(req.data).toEqual({ template_id: 't1', name: 'NDA - Acme', recipients, expiration_hours: 72 });
  });

  it('sends only what was given on resend and cancel', async () => {
    expect((await call('firma_resend_signing_request', { signing_request_id: 's1', recipient_ids: ['u1'] })).data)
      .toEqual({ recipient_ids: ['u1'] });
    expect((await call('firma_cancel_signing_request', { signing_request_id: 's1', notify_signers: true })).data)
      .toEqual({ notify_signers: true });
  });

  it('trims the list of signing requests to what a model needs', () => {
    const raw = {
      results: [
        {
          id: 's1', name: 'NDA', status: 'in_progress', template_id: 't1', credit_cost: 1,
          created_date: '2026-09-28', sent_date: '2026-09-28', document_url: 'https://signed.example/x.pdf',
          fields: [{ id: 'f1' }], settings: { allow_download: true },
          recipients: [{ name: 'Ada', email: 'ada@example.com', designation: 'Signer', finished_on: null, phone_number: '+49' }],
        },
      ],
      pagination: { current_page: 1, page_size: 20, total_count: 1, total_pages: 1 },
    };
    const out = applyResponseTransform(raw, tool('firma_list_signing_requests').responseMapping as any).value as any;
    expect(out.pagination.total_pages).toBe(1);
    expect(out.results[0]).toMatchObject({ id: 's1', status: 'in_progress', credit_cost: 1 });
    expect(out.results[0]).not.toHaveProperty('document_url');
    expect(out.results[0]).not.toHaveProperty('fields');
    expect(out.results[0].recipients[0]).toEqual({
      name: 'Ada', email: 'ada@example.com', designation: 'Signer', finished_on: null, declined_on: null,
    });
  });

  it('marks reads read-only and never calls a send or cancel read-only', () => {
    const ann = (t: Tool) =>
      deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });
    for (const t of a.tools.filter((x) => x.endpointMapping.method === 'GET')) {
      expect({ tool: t.name, ro: ann(t).readOnlyHint }).toEqual({ tool: t.name, ro: true });
    }
    expect(ann(tool('firma_send_signing_request'))).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(ann(tool('firma_resend_signing_request'))).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(ann(tool('firma_cancel_signing_request'))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(ann(tool('firma_create_signing_request_from_template'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('exposes no workspace tool: those responses carry API keys', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/workspace/);
  });

  it('only names tools that exist', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bfirma_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bfirma_[a-z_]+/g)]),
    ].map((m) => m[0]);
    expect(mentioned.length).toBeGreaterThan(10);
    for (const n of mentioned) expect(names).toContain(n);
  });
});

const live = process.env.RUN_FIRMA_LIVE ? describe : describe.skip;
live('firma adapter — live API (reads only)', () => {
  beforeAll(() => {
    if (!process.env.FIRMA_API_KEY) throw new Error('Set FIRMA_API_KEY (a test key is enough)');
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });
  const run = (name: string, params: Record<string, unknown> = {}) =>
    engine().execute(config(process.env.FIRMA_API_KEY), tool(name).endpointMapping as any, params) as Promise<any>;

  it('lists templates', async () => {
    const out = await run('firma_list_templates', { page_size: 5 });
    expect(Array.isArray(out.results)).toBe(true);
  }, 30_000);

  it('lists signing requests and reads the first one', async () => {
    const out = await run('firma_list_signing_requests', { page_size: 5 });
    expect(out.pagination).toBeDefined();
    if (out.results.length) {
      const id = out.results[0].id;
      expect((await run('firma_get_signing_request', { signing_request_id: id })).id).toBe(id);
      expect(Array.isArray((await run('firma_list_signing_request_recipients', { signing_request_id: id })).results)).toBe(true);
    }
  }, 30_000);
});
