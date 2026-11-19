import axios from 'axios';
import * as adapter from './hh-ru.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { getAdapter, listAdapters } from '../catalog';

/**
 * HeadHunter (hh.ru) adapter: reference data and autocomplete without a
 * token, vacancy and employer search with an application token.
 *
 * Static checks always run: no connector-level auth, the mandatory
 * HH-User-Agent header, every tool's method, path and required parameters
 * against HeadHunter's public OpenAPI specification
 * (https://api.hh.ru/openapi/specification/public), and that the optional
 * token travels only on the tools that need it and never as a literal
 * placeholder.
 * https://api.hh.ru/openapi/redoc
 *
 * Live checks run only with RUN_HH_RU_LIVE=1. They need no account: they read
 * the keyless endpoints and confirm that vacancy search answers 403 without a
 * token. With HH_ACCESS_TOKEN they also run one vacancy search. Reads only.
 *
 *   RUN_HH_RU_LIVE=1 npx jest src/adapters/intl/hh-ru.live.spec.ts
 */

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
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown; pattern?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  aliases: string[];
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const annotationsOf = (entry: Tool) =>
  deriveToolAnnotations({ name: entry.name, connectorType: 'REST', endpointMapping: entry.endpointMapping, annotations: entry.annotations });
const used = (entry: Tool) => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

const ENV: Record<string, string> = { HH_ACCESS_TOKEN: 'APPLTESTTOKEN0123456789ABCDEFGHIJKLMNOPQRSTUV' };
const BASE = 'https://api.hh.ru';
const UA = 'AnythingMCP/1.0 (support@anythingmcp.com)';
const TOKEN_HEADER = 'Bearer ${HH_ACCESS_TOKEN}';

const call = (name: string, params: Record<string, unknown>, env: Record<string, string> = ENV) => {
  const { config: cfg, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    { baseUrl: cfg.baseUrl, authType: a.connector.authType, headers: cfg.headers } as never,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as never, params), ...env },
  );
};
const sent = () => mockedAxios.mock.calls.at(-1)![0];
const ok = () => mockedAxios.mockResolvedValueOnce({ status: 200, data: { items: [] }, headers: {} });
const header = (req: { headers: Record<string, string> }, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// name, path, required parameters, needs the token. Every tool is a GET.
const CONTRACT: Array<[string, string, string[], boolean]> = [
  ['hh_ru_get_dictionaries', '/dictionaries', [], false],
  ['hh_ru_list_locales', '/locales', [], false],
  ['hh_ru_list_countries', '/areas/countries', [], false],
  ['hh_ru_get_area', '/areas/{area_id}', ['area_id'], false],
  ['hh_ru_suggest_areas', '/suggests/areas', ['text'], false],
  ['hh_ru_list_metro_stations', '/metro/{city_id}', ['city_id'], false],
  ['hh_ru_list_professional_roles', '/professional_roles', [], false],
  ['hh_ru_suggest_professional_roles', '/suggests/professional_roles', ['text'], false],
  ['hh_ru_list_industries', '/industries', [], false],
  ['hh_ru_list_languages', '/languages', [], false],
  ['hh_ru_suggest_vacancy_positions', '/suggests/vacancy_positions', ['text'], false],
  ['hh_ru_suggest_resume_positions', '/suggests/positions', ['text'], false],
  ['hh_ru_suggest_vacancy_keywords', '/suggests/vacancy_search_keyword', ['text'], false],
  ['hh_ru_suggest_companies', '/suggests/companies', ['text'], false],
  ['hh_ru_suggest_skills', '/suggests/skill_set', ['text'], false],
  ['hh_ru_get_skills', '/skills', ['ids'], false],
  ['hh_ru_suggest_educational_institutions', '/suggests/educational_institutions', ['text'], false],
  ['hh_ru_get_educational_institutions', '/educational_institutions', ['ids'], false],
  ['hh_ru_list_faculties', '/educational_institutions/{institution_id}/faculties', ['institution_id'], false],
  ['hh_ru_suggest_fields_of_study', '/suggests/fields_of_study', ['text'], false],
  ['hh_ru_list_similar_vacancies', '/vacancies/{vacancy_id}/similar_vacancies', ['vacancy_id'], true],
  ['hh_ru_search_vacancies', '/vacancies', [], true],
  ['hh_ru_get_vacancy', '/vacancies/{vacancy_id}', ['vacancy_id'], true],
  ['hh_ru_search_employers', '/employers', [], true],
  ['hh_ru_get_employer', '/employers/{employer_id}', ['employer_id'], true],
  ['hh_ru_get_me', '/me', [], true],
];

describe('hh-ru adapter: static contract', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is a keyless REST connector with the mandatory user agent and one optional token', () => {
    expect(a.slug).toBe('hh-ru');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('hr');
    expect(a.icon).toBe('hh-ru');
    expect(a.aliases).toEqual(expect.arrayContaining(['HeadHunter', 'hh.ru', 'ХедХантер']));
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.headers).toMatchObject({ 'HH-User-Agent': UA, 'User-Agent': UA });
    // HeadHunter asks for "AppName/1.0 (contact e-mail)".
    expect(UA).toMatch(/^[\w.-]+\/[\d.]+ \([^()\s]+@[^()\s]+\)$/);
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.optionalEnvVars).toEqual(['HH_ACCESS_TOKEN']);
    expect(a.envVarMeta.HH_ACCESS_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.HH_ACCESS_TOKEN.pattern!);
    expect(pattern.test(ENV.HH_ACCESS_TOKEN)).toBe(true);
    for (const bad of ['', 'Bearer APPLTESTTOKEN0123456789ABCDEFGH', 'has space in the token 0123456789']) expect(pattern.test(bad)).toBe(false);
    // An optional variable in a connector header would be sent as a literal placeholder.
    expect(JSON.stringify(a.connector.headers)).not.toContain('HH_ACCESS_TOKEN');
  });

  it('probes a keyless read and explains 400, 403, 404 and rate limits', () => {
    expect(a.probe).toEqual({ tool: 'hh_ru_list_locales', params: {} });
    expect(tool(a.probe.tool).endpointMapping.headers).toBeUndefined();
    for (const key of ['400', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });

  it('maps every tool to the documented GET path and sends the token only where hh.ru asks for it', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(CONTRACT.map(([name]) => name).sort());
    for (const [name, path, required, withToken] of CONTRACT) {
      const entry = tool(name);
      expect(entry.endpointMapping.method).toBe('GET');
      expect(entry.endpointMapping.path).toBe(path);
      expect([...(entry.parameters.required ?? [])].sort()).toEqual([...required].sort());
      if (withToken) expect(entry.endpointMapping.headers).toEqual({ Authorization: TOKEN_HEADER });
      else expect(entry.endpointMapping.headers).toBeUndefined();
    }
  });

  it('prefixes every tool, shares no tool name with another adapter, and declares every argument it reads', () => {
    const mine = new Set(a.tools.map((entry) => entry.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^hh_ru_[a-z0-9_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const other of getAdapter(meta.slug)!.tools) expect(mine.has(other.name)).toBe(false);
    }
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      for (const arg of used(entry)) expect(declared.has(arg) || envNames.has(arg)).toBe(true);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(40);
    }
  });

  it('is read-only: every tool is a read and nothing is switched off', () => {
    for (const entry of a.tools) {
      expect(annotationsOf(entry).readOnlyHint).toBe(true);
      expect(entry.enabled).not.toBe(false);
      expect(entry.endpointMapping.bodyMapping).toBeUndefined();
    }
    // Nothing that acts for an applicant or an employer.
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toMatch(/resumes|negotiations|drafts|chats|salary_statistics/);
  });

  it('names every tool in the instructions', () => {
    for (const entry of a.tools) expect(a.instructions).toContain(entry.name);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('accepts real ids and refuses anything that is not digits', () => {
    const idPattern = (name: string, param: string) => new RegExp(tool(name).parameters.properties![param].pattern!);
    expect(idPattern('hh_ru_get_area', 'area_id').test('2019')).toBe(true);
    expect(idPattern('hh_ru_get_vacancy', 'vacancy_id').test('139663865')).toBe(true);
    expect(idPattern('hh_ru_get_employer', 'employer_id').test('1740')).toBe(true);
    for (const bad of ['', '1/similar_vacancies', '../me', '12 34']) expect(idPattern('hh_ru_get_vacancy', 'vacancy_id').test(bad)).toBe(false);
  });

  it('reads reference data and suggestions without an Authorization header', async () => {
    ok();
    await call('hh_ru_get_dictionaries', { locale: 'EN' });
    let req = sent();
    expect(req.url).toBe(`${BASE}/dictionaries`);
    expect(String(req.method).toUpperCase()).toBe('GET');
    expect(req.params).toEqual({ locale: 'EN' });
    expect(header(req, 'HH-User-Agent')).toBe(UA);
    expect(header(req, 'User-Agent')).toBe(UA);
    expect(header(req, 'Authorization')).toBeUndefined();

    ok();
    await call('hh_ru_suggest_areas', { text: 'Казан' });
    req = sent();
    expect(req.url).toBe(`${BASE}/suggests/areas`);
    expect(req.params).toEqual({ text: 'Казан' });
    expect(header(req, 'Authorization')).toBeUndefined();

    ok();
    await call('hh_ru_get_area', { area_id: '2019' });
    expect(sent().url).toBe(`${BASE}/areas/2019`);

    ok();
    await call('hh_ru_list_metro_stations', { city_id: '1', locale: 'EN' });
    expect(sent().url).toBe(`${BASE}/metro/1`);
    expect(sent().params).toEqual({ locale: 'EN' });

    ok();
    await call('hh_ru_get_skills', { ids: ['1114', '665'] });
    expect(sent().url).toBe(`${BASE}/skills`);
    expect(sent().params).toEqual({ id: ['1114', '665'] });

    ok();
    await call('hh_ru_list_faculties', { institution_id: '38921' });
    expect(sent().url).toBe(`${BASE}/educational_institutions/38921/faculties`);

    ok();
    await call('hh_ru_suggest_companies', { text: 'sber', locale: 'EN' });
    expect(sent().url).toBe(`${BASE}/suggests/companies`);
    expect(sent().params).toEqual({ text: 'sber', locale: 'EN' });
  });

  it('searches vacancies and employers with the application token as a bearer', async () => {
    ok();
    await call('hh_ru_search_vacancies', {
      text: 'python',
      area: ['1', '2'],
      experience: ['between1And3'],
      work_format: ['REMOTE'],
      salary: 200000,
      label: ['with_salary'],
      order_by: 'publication_time',
      per_page: 50,
    });
    let req = sent();
    expect(req.url).toBe(`${BASE}/vacancies`);
    expect(req.params).toEqual({
      text: 'python',
      area: ['1', '2'],
      experience: ['between1And3'],
      work_format: ['REMOTE'],
      salary: 200000,
      label: ['with_salary'],
      order_by: 'publication_time',
      page: 0,
      per_page: 50,
    });
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.HH_ACCESS_TOKEN}`);
    expect(header(req, 'HH-User-Agent')).toBe(UA);

    ok();
    await call('hh_ru_get_vacancy', { vacancy_id: '139663865', locale: 'EN' });
    req = sent();
    expect(req.url).toBe(`${BASE}/vacancies/139663865`);
    expect(req.params).toEqual({ locale: 'EN' });
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENV.HH_ACCESS_TOKEN}`);

    ok();
    await call('hh_ru_search_employers', { text: 'yandex', only_with_vacancies: true, sort_by: 'by_vacancies_open' });
    req = sent();
    expect(req.url).toBe(`${BASE}/employers`);
    expect(req.params).toEqual({ text: 'yandex', only_with_vacancies: true, sort_by: 'by_vacancies_open', page: 0, per_page: 20 });

    ok();
    await call('hh_ru_get_employer', { employer_id: '1740' });
    expect(sent().url).toBe(`${BASE}/employers/1740`);

    ok();
    await call('hh_ru_get_me', {});
    expect(sent().url).toBe(`${BASE}/me`);
    expect(header(sent(), 'Authorization')).toBe(`Bearer ${ENV.HH_ACCESS_TOKEN}`);
  });

  it('sends no Authorization header while no token is set', async () => {
    for (const token of [undefined, '']) {
      const env: Record<string, string> = {};
      if (token !== undefined) env.HH_ACCESS_TOKEN = token;
      ok();
      await call('hh_ru_list_similar_vacancies', { vacancy_id: '139663865', text: 'администратор', area: ['1'] }, env);
      const req = sent();
      expect(req.url).toBe(`${BASE}/vacancies/139663865/similar_vacancies`);
      expect(req.params).toEqual({ text: 'администратор', area: ['1'], page: 0, per_page: 20 });
      expect(header(req, 'Authorization')).toBeUndefined();
      expect(JSON.stringify(req.headers)).not.toContain('HH_ACCESS_TOKEN');
    }
  });
});

// Opt-in: RUN_HH_RU_LIVE=1. No account is needed for the first three checks.
// With HH_ACCESS_TOKEN (an approved application's token) one vacancy search
// runs as well. Nothing is written.
const live = process.env.RUN_HH_RU_LIVE === '1';
const liveFetch = mockedAxios.__actual;
const liveHeaders = { 'HH-User-Agent': UA, 'User-Agent': UA, Accept: 'application/json' };
(live ? describe : describe.skip)('hh.ru: live', () => {
  it('reads dictionaries, countries and area suggestions without a token', async () => {
    const dictionaries = await liveFetch.get(`${BASE}/dictionaries`, { headers: liveHeaders, params: { locale: 'EN' }, validateStatus: () => true });
    expect(dictionaries.status).toBe(200);
    expect(Array.isArray(dictionaries.data.experience)).toBe(true);
    expect(Array.isArray(dictionaries.data.work_format)).toBe(true);

    const countries = await liveFetch.get(`${BASE}/areas/countries`, { headers: liveHeaders, validateStatus: () => true });
    expect(countries.status).toBe(200);
    expect(countries.data.some((c: { id: string }) => c.id === '113')).toBe(true);

    const areas = await liveFetch.get(`${BASE}/suggests/areas`, { headers: liveHeaders, params: { text: 'Казан' }, validateStatus: () => true });
    expect(areas.status).toBe(200);
    expect(areas.data.items.some((i: { id: string }) => i.id === '88')).toBe(true);
  });

  it('refuses a one-character suggestion with 400 and names the parameter', async () => {
    const response = await liveFetch.get(`${BASE}/suggests/areas`, { headers: liveHeaders, params: { text: 'M' }, validateStatus: () => true });
    expect(response.status).toBe(400);
    expect(response.data.bad_argument).toBe('text');
  });

  it('answers 403 on vacancy search without a token, and on a wrong token', async () => {
    const anonymous = await liveFetch.get(`${BASE}/vacancies`, { headers: liveHeaders, params: { text: 'python', per_page: 1 }, validateStatus: () => true });
    expect(anonymous.status).toBe(403);
    const wrong = await liveFetch.get(`${BASE}/me`, {
      headers: { ...liveHeaders, Authorization: 'Bearer NOTAREALTOKEN' },
      validateStatus: () => true,
    });
    expect(wrong.status).toBe(403);
    expect(wrong.data.errors[0]).toMatchObject({ type: 'oauth', value: 'bad_authorization' });
  });

  it('searches vacancies with an application token', async () => {
    const token = process.env.HH_ACCESS_TOKEN;
    if (!token) throw new Error('Set HH_ACCESS_TOKEN for the vacancy search check');
    const response = await liveFetch.get(`${BASE}/vacancies`, {
      headers: { ...liveHeaders, Authorization: `Bearer ${token}` },
      params: { text: 'python', area: 1, per_page: 1 },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(typeof response.data.found).toBe('number');
  });
});
