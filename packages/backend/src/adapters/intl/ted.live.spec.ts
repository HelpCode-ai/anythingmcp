import axios from 'axios';
import * as yaml from 'js-yaml';
import * as adapter from './ted.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * TED (Tenders Electronic Daily), the EU's public procurement journal,
 * through its public Search API v3. No key is needed for search.
 *
 *   1. Static: always runs. Pins the request body of every tool (all four
 *      call POST /v3/notices/search), the field defaults and the response
 *      mappings that cut the 24-language link block down to one link each.
 *
 *   2. Live: skipped unless TED_LIVE=1. Needs no account:
 *
 *        TED_LIVE=1 npx jest src/adapters/intl/ted.live.spec.ts
 *
 *      Checks every body field and default field name against TED's own
 *      OpenAPI document (https://api.ted.europa.eu/api-v3.yaml), then runs
 *      real searches through the engine: a sector search, a notice by
 *      publication number, a count, iteration paging, the syntax check and
 *      TED's errors for a bad query and an unknown field.
 *
 * Verified live on 12 Oct 2026.
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
  parameters: { properties: Record<string, { default?: unknown; enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyMapping: Record<string, unknown> };
  responseMapping: { transform: { mode: string; expression: string } };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  unlisted?: boolean;
  instructions: string;
  requiredEnvVars: string[];
  probe: { tool: string; params: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const BASE = 'https://api.ted.europa.eu';
const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const execute = (name: string, params: Record<string, unknown>) =>
  engine().execute(
    { baseUrl: a.connector.baseUrl, authType: 'NONE', headers: a.connector.headers },
    tool(name).endpointMapping,
    applySchemaDefaults(tool(name).parameters, params),
  ) as Promise<any>;
const sent = () => mockedAxios.mock.calls[0][0];
const sentBody = () => {
  const data = sent().data;
  return typeof data === 'string' ? JSON.parse(data) : data;
};
const transform = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as never);

const langs = ['BUL', 'SPA', 'DEU', 'ENG', 'FRA', 'ITA'];
const linksOf = (pn: string) => ({
  xml: { MUL: `https://ted.europa.eu/en/notice/${pn}/xml` },
  pdf: Object.fromEntries(langs.map((l) => [l, `https://ted.europa.eu/${l.slice(0, 2).toLowerCase()}/notice/${pn}/pdf`])),
  pdfs: { DEU: `https://ted.europa.eu/de/notice/${pn}/pdfs` },
  html: Object.fromEntries(langs.map((l) => [l, `https://ted.europa.eu/${l.slice(0, 2).toLowerCase()}/notice/-/detail/${pn}`])),
  htmlDirect: Object.fromEntries(langs.map((l) => [l, `https://ted.europa.eu/${l.slice(0, 2).toLowerCase()}/notice/${pn}/html`])),
});
// Trimmed from a real response of 12 Oct 2026.
const NOTICE = {
  'publication-number': '703792-2026',
  'publication-date': '2026-10-12+02:00',
  'notice-type': 'cn-standard',
  'title-proc': { deu: 'Pflege- und Supportleistungen für die Software „Operations Orchestration“' },
  'buyer-name': { deu: ['Deutsche Bundesbank, Zentralbereich Beschaffungen'] },
  'buyer-country': ['DEU'],
  'classification-cpv': ['72260000', '72260000'],
  'deadline-receipt-tender-date-lot': ['2026-11-09+01:00'],
  links: linksOf('703792-2026'),
};
const COMPACT_LINKS = {
  html: 'https://ted.europa.eu/en/notice/-/detail/703792-2026',
  pdf: 'https://ted.europa.eu/en/notice/703792-2026/pdf',
  xml: 'https://ted.europa.eu/en/notice/703792-2026/xml',
};

describe('ted adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed (verified live against the TED Search API on 12 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.name).toBe('TED (EU Public Tenders)');
    expect(a.region).toBe('eu');
    expect(a.category).toBe('government');
  });

  it('calls the public search API without credentials', () => {
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe(BASE);
    expect(a.connector.authType).toBe('NONE');
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.healthcheckPath).toBe('/swagger-ui/index.html');
    expect(a.probe).toEqual({ tool: 'ted_count_notices', params: { query: 'publication-date>=today(-7)' } });
  });

  it('has the four read-only search tools, all on POST /v3/notices/search', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(['ted_check_query', 'ted_count_notices', 'ted_get_notice', 'ted_search_notices']);
    for (const t of a.tools) {
      expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/v3/notices/search' });
      expect(t.description.length).toBeGreaterThanOrEqual(40);
      for (const r of t.parameters.required ?? []) expect(t.parameters.properties).toHaveProperty(r);
      // A search is a POST, so the read-only hint has to be set explicitly.
      expect(deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }).readOnlyHint).toBe(true);
      expect(validateTransform(t.responseMapping.transform)).toBeNull();
    }
  });

  it('searches with the compact default fields, page 1 of 10 and scope ALL', async () => {
    mockedAxios.mockResolvedValue({ data: { notices: [] } });
    await execute('ted_search_notices', { query: 'classification-cpv IN (72000000) AND buyer-country=DEU' });
    expect(sent()).toEqual(expect.objectContaining({ method: 'POST', url: `${BASE}/v3/notices/search` }));
    expect(sentBody()).toEqual({
      query: 'classification-cpv IN (72000000) AND buyer-country=DEU',
      fields: tool('ted_search_notices').parameters.properties.fields.default,
      limit: 10,
      page: 1,
      scope: 'ALL',
    });
    expect((tool('ted_search_notices').parameters.properties.fields.default as string[]).length).toBe(15);
  });

  it('passes paging, scope and iteration settings through', async () => {
    mockedAxios.mockResolvedValue({ data: { notices: [] } });
    await execute('ted_search_notices', {
      query: 'buyer-country=AUT',
      fields: ['publication-number'],
      limit: 50,
      scope: 'ACTIVE',
      paginationMode: 'ITERATION',
      iterationNextToken: 'abc',
      onlyLatestVersions: true,
    });
    expect(sentBody()).toEqual({
      query: 'buyer-country=AUT',
      fields: ['publication-number'],
      limit: 50,
      page: 1,
      scope: 'ACTIVE',
      paginationMode: 'ITERATION',
      iterationNextToken: 'abc',
      onlyLatestVersions: true,
    });
  });

  it('gets a notice through a publication-number query over all notices', async () => {
    mockedAxios.mockResolvedValue({ data: { notices: [] } });
    await execute('ted_get_notice', { publicationNumber: '703792-2026' });
    const body = sentBody();
    expect(body.query).toBe('publication-number=703792-2026');
    expect(body.limit).toBe(1);
    expect(body.scope).toBe('ALL');
    expect(body.fields).toEqual(expect.arrayContaining(['description-lot', 'document-url-lot', 'submission-url-lot', 'winner-name']));
    expect(body.fields.length).toBe(35);
  });

  it('counts with one field and one notice, and checks syntax without running the query', async () => {
    mockedAxios.mockResolvedValue({ data: { notices: [] } });
    await execute('ted_count_notices', { query: 'buyer-country=ITA' });
    expect(sentBody()).toEqual({ query: 'buyer-country=ITA', fields: ['publication-number'], limit: 1, scope: 'ALL' });
    mockedAxios.mockClear();
    await execute('ted_check_query', { query: 'buyer-country=ITA' });
    expect(sentBody()).toEqual({ query: 'buyer-country=ITA', fields: ['publication-number'], checkQuerySyntax: true });
  });

  it('keeps one HTML, PDF and XML link per notice instead of 24 languages of each', () => {
    const raw = { notices: [NOTICE], totalNoticeCount: 3807, iterationNextToken: null, timedOut: false };
    const out = transform('ted_search_notices', raw);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({
      totalNoticeCount: 3807,
      iterationNextToken: null,
      timedOut: false,
      notices: [{ ...NOTICE, links: COMPACT_LINKS }],
    });
    expect(JSON.stringify(out.value).length).toBeLessThan(JSON.stringify(raw).length / 2);
  });

  it('returns one notice, or found: false', () => {
    expect(transform('ted_get_notice', { notices: [NOTICE], totalNoticeCount: 1 }).value).toEqual({
      found: true,
      notice: { ...NOTICE, links: COMPACT_LINKS },
    });
    expect(transform('ted_get_notice', { notices: [], totalNoticeCount: 0 }).value).toEqual({ found: false, notice: null });
  });

  it('reduces a count and a syntax check to their answer', () => {
    expect(transform('ted_count_notices', { notices: [NOTICE], totalNoticeCount: 22661, timedOut: false }).value).toEqual({
      totalNoticeCount: 22661,
      timedOut: false,
    });
    expect(transform('ted_check_query', { notices: [], totalNoticeCount: null }).value).toEqual({ valid: true });
  });

  it('teaches the query language and the limits', () => {
    expect(a.instructions).toMatch(/no account or API key/);
    expect(a.instructions).toMatch(/AND NOT/);
    expect(a.instructions).toMatch(/alpha-3/);
    expect(a.instructions).toMatch(/15,000/);
    expect(a.instructions).toMatch(/10,000/);
    expect(a.instructions).toMatch(/ITERATION/);
    expect(a.instructions).toMatch(/QUERY_UNKNOWN_FIELD/);
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.TED_LIVE === '1' ? describe : describe.skip;

live('ted adapter: live TED Search API v3', () => {
  jest.setTimeout(60_000);
  beforeAll(() => {
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  it("matches TED's own OpenAPI document", async () => {
    const res = await mockedAxios.__actual.get(`${BASE}/api-v3.yaml`, { responseType: 'text' });
    const spec = yaml.load(res.data as string) as any;
    const op = spec.paths['/v3/notices/search'].post;
    expect(op.security).toBeUndefined();
    const ref = op.requestBody.content['application/json'].schema.$ref.split('/').pop();
    const schema = spec.components.schemas[ref];
    const known: string[] = schema.properties.fields.enum;
    for (const t of a.tools) {
      for (const key of Object.keys(t.endpointMapping.bodyMapping)) expect(Object.keys(schema.properties)).toContain(key);
      const fields = t.parameters.properties.fields?.default ?? t.endpointMapping.bodyMapping.fields;
      for (const f of fields as string[]) expect(known).toContain(f);
    }
    expect(tool('ted_search_notices').parameters.properties.scope.enum!.sort()).toEqual([...schema.properties.scope.enum].sort());
    expect(tool('ted_search_notices').parameters.properties.paginationMode.enum).toEqual(schema.properties.paginationMode.enum);
  });

  let first: any;

  it('finds open IT tenders in Germany, newest first, with compact links', async () => {
    const raw = await execute('ted_search_notices', {
      query: 'classification-cpv IN (72000000) AND buyer-country=DEU AND deadline-receipt-tender-date-lot>=today() SORT BY publication-date DESC',
      limit: 3,
      scope: 'ACTIVE',
    });
    expect(raw.totalNoticeCount).toBeGreaterThan(0);
    expect(raw.notices.length).toBeGreaterThan(0);
    const out = transform('ted_search_notices', raw).value as any;
    first = out.notices[0];
    expect(first['publication-number']).toMatch(/^\d+-\d{4}$/);
    expect(first['buyer-country']).toContain('DEU');
    expect(first.links.html).toMatch(/^https:\/\/ted\.europa\.eu\/en\/notice\/-\/detail\//);
    expect(first.links.pdf).toMatch(/\/pdf$/);
    expect(first.links.xml).toMatch(/\/xml$/);
  });

  it('gets that notice by publication number', async () => {
    const out = transform('ted_get_notice', await execute('ted_get_notice', { publicationNumber: first['publication-number'] })).value as any;
    expect(out.found).toBe(true);
    expect(out.notice['publication-number']).toBe(first['publication-number']);
    expect(out.notice['title-proc']).toBeDefined();
    const none = transform('ted_get_notice', await execute('ted_get_notice', { publicationNumber: '999999-2026' })).value as any;
    expect(none).toEqual({ found: false, notice: null });
  });

  it('counts, and walks pages in iteration mode', async () => {
    const count = transform('ted_count_notices', await execute('ted_count_notices', { query: 'publication-date>=today(-7)' })).value as any;
    expect(count.totalNoticeCount).toBeGreaterThan(1000);
    const query = 'buyer-country=AUT AND publication-date>=today(-14)';
    const p1 = await execute('ted_search_notices', { query, fields: ['publication-number'], limit: 2, paginationMode: 'ITERATION' });
    expect(p1.iterationNextToken).toBeTruthy();
    const p2 = await execute('ted_search_notices', { query, fields: ['publication-number'], limit: 2, paginationMode: 'ITERATION', iterationNextToken: p1.iterationNextToken });
    const ids = (r: any) => r.notices.map((n: any) => n['publication-number']);
    expect(ids(p2).length).toBeGreaterThan(0);
    expect(ids(p2)).not.toEqual(ids(p1));
  });

  it("checks syntax, and reports TED's errors for a bad query and an unknown field", async () => {
    expect(transform('ted_check_query', await execute('ted_check_query', { query: 'buyer-country=ITA AND notice-type=can-standard' })).value).toEqual({ valid: true });
    // The engine raises the upstream 400; the MCP layer hands its body to the model.
    const tedError = async (name: string, params: Record<string, unknown>) => {
      try {
        await execute(name, params);
      } catch (err: any) {
        expect(err.response?.status).toBe(400);
        return err.response.data;
      }
      throw new Error(`${name} did not fail`);
    };
    const syntax = await tedError('ted_check_query', { query: 'buyer-country=ITA AND (' });
    expect(syntax.error.type).toBe('QUERY_SYNTAX_ERROR');
    expect(syntax.error.location.beginColumn).toBe(23);
    const unknown = await tedError('ted_search_notices', { query: 'bogus-field=1' });
    expect(unknown.error).toEqual(expect.objectContaining({ type: 'QUERY_UNKNOWN_FIELD', fieldName: 'bogus-field' }));
  });
});
