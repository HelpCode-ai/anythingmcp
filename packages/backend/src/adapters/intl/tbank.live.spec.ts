import * as adapter from './tbank.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * T-Bank Business API, T-API (developer.tbank.ru/docs/api): https://business.tbank.ru/openapi (sandbox /openapi/sandbox with
 * the token TBankSandboxToken), Bearer token issued in T-Business; company, accounts v4, statement v1, payment document,
 * invoice info, acquiring terminals and operations, webhooks. The host presents a Russian Trusted Root CA certificate.
 * Live part: NODE_EXTRA_CA_CERTS=russian_trusted_root_ca.pem TBANK_API_URL=https://business.tbank.ru/openapi/sandbox
 *   TBANK_API_TOKEN=TBankSandboxToken RUN_TBANK_LIVE=1 npx jest src/adapters/intl/tbank (reads only: company and accounts).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
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
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe?: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Connector variables (upper case) are filled in by the connector, not by the model.
const isEnv = (p: string) => /^[A-Z][A-Z0-9_]*$/.test(p);
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
  for (const p of [...out]) if (isEnv(p)) out.delete(p);
  return out;
};

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
    AxiosHeaders: actual.AxiosHeaders,
  };
});
const mockedAxios = axios as unknown as jest.Mock;
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
// Runs a tool through the real REST engine (axios mocked) and returns the request it built.
const request = async (name: string, args: Record<string, unknown>, env: Record<string, string> = {}) => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ status: 200, data: {}, headers: {} });
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => env[k] ?? '');
  const authConfig = JSON.parse(fill(JSON.stringify(a.connector.authConfig ?? {})));
  await engine().execute(
    { baseUrl: fill(a.connector.baseUrl), authType: a.connector.authType, authConfig, headers: a.connector.headers } as never,
    JSON.parse(fill(JSON.stringify(tool(name).endpointMapping))),
    { ...env, ...args },
  );
  return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as { method: string; url: string; params?: Record<string, unknown>; data?: unknown; headers: Record<string, string> };
};
const PREFIX = 'tbank_';
const WRITES: string[] = [];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('tbank adapter: static spec conformance', () => {
  it('sends the T-API token as a Bearer token to business.tbank.ru/openapi', () => {
    expect(a.requiredEnvVars).toEqual(['TBANK_API_URL', 'TBANK_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('{{TBANK_API_URL}}');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{TBANK_API_TOKEN}}' });
    expect(a.envVarMeta?.TBANK_API_TOKEN.secret).toBe(true);
    const re = new RegExp(a.envVarMeta?.TBANK_API_URL.pattern as string);
    expect(re.test('https://business.tbank.ru/openapi')).toBe(true);
    expect(re.test('https://business.tbank.ru/openapi/sandbox')).toBe(true);
    expect(re.test('https://secured-openapi.tbank.ru')).toBe(false);
    expect(new RegExp(a.envVarMeta?.TBANK_API_TOKEN.pattern as string).test('TBankSandboxToken')).toBe(true);
    expect(a.probe).toEqual({ tool: 'tbank_get_company' });
  });

  it('is offered for self-hosted AnythingMCP only, because Cloud does not trust the Russian Trusted Root CA', () => {
    const meta = adapter as unknown as { selfHostOnly?: boolean; instructions: string };
    expect(meta.selfHostOnly).toBe(true);
    expect(meta.instructions).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('is read-only: every tool is a GET', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('maps the documented accounts, statement and document routes', async () => {
    const env = { TBANK_API_URL: 'https://business.tbank.ru/openapi', TBANK_API_TOKEN: 't.abc' };
    const acc = await request('tbank_list_accounts', { with_invest: true }, env);
    expect(acc.url).toBe('https://business.tbank.ru/openapi/api/v4/bank-accounts');
    expect(acc.params).toEqual({ withInvest: true });
    expect(acc.headers.Authorization).toBe('Bearer t.abc');
    const st = await request('tbank_get_statement', { account_number: '40702810110011000000', from: '2026-10-01T00:00:00Z', cursor: 'c1', limit: 500, operation_status: 'Transaction', counterparty_inns: ['7707083893'] }, env);
    expect(st.url).toBe('https://business.tbank.ru/openapi/api/v1/statement');
    expect(st.params).toMatchObject({ accountNumber: '40702810110011000000', from: '2026-10-01T00:00:00Z', cursor: 'c1', limit: 500, operationStatus: 'Transaction' });
    expect(tool('tbank_get_statement').endpointMapping.queryParams).toMatchObject({ withBalances: '$with_balances', categories: '$categories', inns: '$counterparty_inns', ucid: '$card_ucid', to: '$to' });
    expect(tool('tbank_get_payment_document').endpointMapping.queryParams).toEqual({ accountNumber: '$account_number', operationId: '$operation_id', operationDate: '$operation_date' });
    expect(tool('tbank_get_company').endpointMapping.path).toBe('/api/v1/company');
    expect(tool('tbank_get_invoice_info').endpointMapping.path).toBe('/api/v1/openapi/invoice/{invoice_id}/info');
    expect(tool('tbank_list_terminals').endpointMapping).toMatchObject({ path: '/api/v1/tacq/terminals', queryParams: { page: '$page', size: '$size' } });
    expect(tool('tbank_list_terminal_operations').endpointMapping).toMatchObject({ path: '/api/v1/tacq/operations/terminal/{terminal_key}', queryParams: { from: '$from', till: '$till', limit: '$limit' } });
    expect(tool('tbank_list_webhooks').endpointMapping.path).toBe('/api/v1/webhooks/by-company');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated and installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe!.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const r of probe.parameters?.required ?? []) expect(a.probe!.params?.[r]).toBeDefined();
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_TBANK_LIVE === '1' && process.env.TBANK_API_URL && process.env.TBANK_API_TOKEN ? describe : describe.skip;
live('tbank adapter: live (read-only)', () => {
  const base = (process.env.TBANK_API_URL ?? '').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.TBANK_API_TOKEN}`, Accept: 'application/json' };
  it('reads the company and its accounts', async () => {
    const company = await fetch(`${base}/api/v1/company`, { headers });
    expect(company.status).toBe(200);
    expect(typeof ((await company.json()) as { name: string }).name).toBe('string');
    const accounts = await fetch(`${base}/api/v4/bank-accounts`, { headers });
    expect(accounts.status).toBe(200);
    expect(Array.isArray(await accounts.json())).toBe(true);
  }, 60_000);
});
