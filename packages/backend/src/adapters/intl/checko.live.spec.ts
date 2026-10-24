import * as adapter from './checko.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Checko API v2 (checko.ru/integration/api and the method pages under it): GET https://api.checko.ru/v2/<method>?key=...,
 * answers {data, meta: {status, today_request_count, balance, message}}; errors carry meta.status = error.
 * Live part: CHECKO_API_KEY=... RUN_CHECKO_LIVE=1 npx jest src/adapters/intl/checko
 * (reads only: one bank and one company, two of the 100 free daily requests).
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
const PREFIX = 'checko_';
const WRITES: string[] = [];
const transform = (name: string, body: unknown) => applyResponseTransform(body, tool(name).responseMapping as never).value;
void transform;

describe('checko adapter: static spec conformance', () => {
  it('sends the API key as the key query parameter to api.checko.ru/v2', async () => {
    expect(a.requiredEnvVars).toEqual(['CHECKO_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.checko.ru/v2');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{CHECKO_API_KEY}}' });
    expect(a.envVarMeta?.CHECKO_API_KEY.secret).toBe(true);
    expect(a.probe).toEqual({ tool: 'checko_get_bank', params: { bic: '044525225' } });
    const req = await request('checko_get_company', { inn: '7707083893' }, { CHECKO_API_KEY: 'k1' });
    expect(req.url).toBe('https://api.checko.ru/v2/company');
    expect(req.params).toEqual({ key: 'k1', inn: '7707083893' });
  });

  it('is read-only: every tool is a GET', () => {
    for (const t of a.tools) expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
  });

  it('maps every documented method with its query parameter names', async () => {
    const paths: Record<string, string> = {
      checko_search: '/search', checko_get_company: '/company', checko_get_entrepreneur: '/entrepreneur', checko_get_person: '/person',
      checko_get_finances: '/finances', checko_get_reliability: '/reliability', checko_get_timeline: '/timeline', checko_list_legal_cases: '/legal-cases',
      checko_list_enforcements: '/enforcements', checko_list_contracts: '/contracts', checko_list_fedresurs_messages: '/fedresurs',
      checko_list_bankruptcy_messages: '/bankruptcy-messages', checko_list_inspections: '/inspections', checko_get_bank: '/bank',
    };
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(paths).sort());
    for (const [n, p] of Object.entries(paths)) expect(`${n}:${tool(n).endpointMapping.path}`).toBe(`${n}:${p}`);
    const s = await request('checko_search', { by: 'okved', obj: 'org', query: '62.01', region: '77', all_okved_codes: 'all', active: true, limit: 10 }, { CHECKO_API_KEY: 'k' });
    expect(s.params).toEqual({ key: 'k', by: 'okved', obj: 'org', query: '62.01', region: '77', codes: 'all', active: true, limit: 10 });
    const lc = await request('checko_list_legal_cases', { inn: '7707083893', role: 'defendant', claim_amount_from: 100000, sort: '-date' }, { CHECKO_API_KEY: 'k' });
    expect(lc.params).toEqual({ key: 'k', inn: '7707083893', role: 'defendant', claim_amount_from: 100000, sort: '-date' });
    expect(tool('checko_list_contracts').parameters?.required).toEqual(['law']);
    expect(tool('checko_list_contracts').endpointMapping.queryParams).toMatchObject({ law: '$law', role: '$role' });
    expect(tool('checko_get_finances').endpointMapping.queryParams).toMatchObject({ extended: '$extended' });
  });

  it('turns an error envelope into a failed call', () => {
    const rules = a.connector.config?.errorWhen as Array<{ path: string; equals: string; status: number; messageMatches?: string }>;
    expect(rules[0]).toMatchObject({ path: 'meta.status', equals: 'error', status: 401 });
    expect(new RegExp(rules[0].messageMatches as string, 'i').test('API-ключ не действителен')).toBe(true);
    expect(rules[1]).toMatchObject({ path: 'meta.status', equals: 'error', status: 400 });
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

const live = process.env.RUN_CHECKO_LIVE === '1' && process.env.CHECKO_API_KEY ? describe : describe.skip;
live('checko adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`https://api.checko.ru/v2${path}&key=${process.env.CHECKO_API_KEY}`);
    expect(res.status).toBe(200);
    return res.json() as Promise<{ data: Record<string, unknown>; meta: { status: string } }>;
  };
  it('reads a bank and a company', async () => {
    const bank = await get('/bank?bic=044525225');
    expect(bank.meta.status).toBe('ok');
    const company = await get('/company?inn=7707083893');
    expect(company.data['ИНН']).toBe('7707083893');
  }, 60_000);
});
