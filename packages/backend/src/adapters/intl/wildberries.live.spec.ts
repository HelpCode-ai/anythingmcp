import axios from 'axios';
import * as adapter from './wildberries.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock;

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: Record<string, unknown> & { method: string; path: string };
  annotations?: Record<string, boolean>;
  enabled?: boolean;
};
const a = adapter as unknown as {
  slug: string;
  probe: { tool: string };
  instructions: string;
  description: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

/**
 * Static checks only: the WB API has no keyless endpoint, so there is no
 * live part. Verified against a seller account with
 * scripts/ops/verify-adapter-with-connector.mjs instead.
 */
describe('wildberries adapter: static spec conformance', () => {
  it('marketplace host as base URL, token in Authorization without Bearer', () => {
    expect(a.connector.baseUrl).toBe('https://marketplace-api.wildberries.ru');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig.headerName).toBe('Authorization');
    expect(a.connector.authConfig.apiKey).toBe('{{WILDBERRIES_API_TOKEN}}');
  });

  it('the probe is the cheap common-api ping', () => {
    expect(a.probe.tool).toBe('wildberries_ping');
    expect(tool('wildberries_ping').endpointMapping.path).toBe('https://common-api.wildberries.ru/ping');
  });

  it('every absolute path points at an official wildberries.ru API host', () => {
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      if (/^https?:\/\//.test(p)) {
        expect(new URL(p).hostname).toMatch(/^[a-z-]+-api\.wildberries\.ru$/);
      }
    }
  });

  it('each tool is called on the host of its token category', () => {
    expect(tool('wildberries_list_statistics_orders').endpointMapping.path).toBe(
      'https://statistics-api.wildberries.ru/api/v1/supplier/orders',
    );
    expect(tool('wildberries_list_product_cards').endpointMapping.path).toMatch(/^https:\/\/content-api\./);
    expect(tool('wildberries_list_prices').endpointMapping.path).toMatch(/^https:\/\/discounts-prices-api\./);
    expect(tool('wildberries_get_sales_report_detail').endpointMapping.path).toMatch(/^https:\/\/finance-api\./);
    expect(tool('wildberries_list_new_orders').endpointMapping.path).toBe('/api/v3/orders/new');
  });

  it('switched-off endpoints are not used', () => {
    const paths = a.tools.map((t) => t.endpointMapping.path).join(' ');
    expect(paths).not.toContain('/api/v1/supplier/stocks');
    expect(paths).not.toContain('reportDetailByPeriod');
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('wildberries_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      const mapping = JSON.stringify(t.endpointMapping);
      for (const p of Object.keys(t.parameters.properties ?? {})) {
        expect(`${t.name}:${mapping.includes(`$${p}"`) || mapping.includes(`{${p}}`)}`).toBe(`${t.name}:true`);
      }
    }
  });

  it('POST reads are read-only, stock and price updates are destructive', () => {
    for (const name of [
      'wildberries_get_order_statuses',
      'wildberries_get_stocks',
      'wildberries_get_wb_warehouse_stocks',
      'wildberries_get_sales_report_detail',
      'wildberries_list_product_cards',
    ]) {
      expect(tool(name).endpointMapping.method).toBe('POST');
      expect(tool(name).annotations?.readOnlyHint).toBe(true);
    }
    expect(tool('wildberries_update_stocks').endpointMapping.method).toBe('PUT');
    expect(tool('wildberries_update_stocks').annotations?.destructiveHint).toBe(true);
    expect(tool('wildberries_set_prices').annotations?.destructiveHint).toBe(true);
  });

  it('stock bodies use size ids (chrtIds), not the old sku barcodes', () => {
    expect(tool('wildberries_get_stocks').endpointMapping.bodyMapping).toEqual({ chrtIds: '$chrt_ids' });
    expect(tool('wildberries_update_stocks').endpointMapping.bodyMapping).toEqual({ stocks: '$stocks' });
  });
});

/**
 * Feedbacks, questions and buyer returns. Checked against the official
 * Customer Communication OpenAPI file of dev.wildberries.ru (paths, hosts,
 * query names, body shapes) and against a workspace's own successful calls
 * to POST /api/v1/feedbacks/answer and GET /api/v1/feedbacks. Both hosts
 * check the token before the route, so an unauthenticated probe answers 401
 * on any path and cannot tell a real route from a typo.
 */
describe('wildberries adapter: feedbacks, questions and returns', () => {
  const FB = 'https://feedbacks-api.wildberries.ru';
  const RET = 'https://returns-api.wildberries.ru';
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const call = (name: string, params: Record<string, unknown>) =>
    engine.execute(
      { baseUrl: a.connector.baseUrl, authType: 'API_KEY', authConfig: { headerName: 'Authorization', apiKey: 'tok' } },
      tool(name).endpointMapping as never,
      params,
    );
  const sent = () => mockedAxios.mock.calls[0][0];
  const annotationsOf = (t: Tool) =>
    deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

  beforeEach(() => mockedAxios.mockReset());

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['wildberries_count_unanswered_feedbacks', {}, 'GET', `${FB}/api/v1/feedbacks/count-unanswered`],
    ['wildberries_count_unanswered_questions', {}, 'GET', `${FB}/api/v1/questions/count-unanswered`],
    ['wildberries_check_new_feedbacks_questions', {}, 'GET', `${FB}/api/v1/new-feedbacks-questions`],
    ['wildberries_list_feedbacks', { is_answered: false, take: 100, skip: 0 }, 'GET', `${FB}/api/v1/feedbacks`],
    ['wildberries_get_feedback', { id: 'f1' }, 'GET', `${FB}/api/v1/feedback`],
    ['wildberries_answer_feedback', { id: 'f1', text: 'Спасибо!' }, 'POST', `${FB}/api/v1/feedbacks/answer`],
    ['wildberries_edit_feedback_answer', { id: 'f1', text: 'Спасибо!' }, 'PATCH', `${FB}/api/v1/feedbacks/answer`],
    ['wildberries_list_questions', { is_answered: false, take: 100, skip: 0 }, 'GET', `${FB}/api/v1/questions`],
    ['wildberries_answer_question', { id: 'q1', text: 'Да' }, 'PATCH', `${FB}/api/v1/questions`],
    ['wildberries_reject_question', { id: 'q1', text: 'Спам' }, 'PATCH', `${FB}/api/v1/questions`],
    ['wildberries_list_return_claims', { is_archive: false }, 'GET', `${RET}/api/v1/claims`],
    ['wildberries_answer_return_claim', { id: 'c1', action: 'approve1' }, 'PATCH', `${RET}/api/v1/claim`],
  ];

  it.each(table)('%s sends %s to the right host with the token', async (name, params, method, url) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(sent()).toEqual(expect.objectContaining({ method, url, headers: expect.objectContaining({ Authorization: 'tok' }) }));
  });

  it('lists feedbacks with the camelCase query names Wildberries expects, false included', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_list_feedbacks', { is_answered: false, take: 5000, skip: 0, nm_id: 123, order: 'dateDesc', date_from: 1, date_to: 2 });
    expect(sent().params).toEqual({ isAnswered: false, take: 5000, skip: 0, nmId: 123, order: 'dateDesc', dateFrom: 1, dateTo: 2 });
    for (const name of ['wildberries_list_feedbacks', 'wildberries_list_questions']) {
      expect(tool(name).parameters.required).toEqual(['is_answered', 'take', 'skip']);
    }
  });

  it('answers a feedback with id and text, as the working hand-built tool did', async () => {
    mockedAxios.mockResolvedValue({ data: '' });
    await call('wildberries_answer_feedback', { id: 'f1', text: 'Спасибо за отзыв' });
    expect(sent().data).toEqual({ id: 'f1', text: 'Спасибо за отзыв' });
  });

  it('answers a question with state wbRu and rejects one with state none', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_answer_question', { id: 'q1', text: 'Да' });
    expect(sent().data).toEqual({ id: 'q1', answer: { text: 'Да' }, state: 'wbRu' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_reject_question', { id: 'q1', text: 'Спам' });
    expect(sent().data).toEqual({ id: 'q1', answer: { text: 'Спам' }, state: 'none' });
  });

  it('decides on a return with the action and leaves the comment out unless given', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_answer_return_claim', { id: 'c1', action: 'approve1' });
    expect(sent().data).toEqual({ id: 'c1', action: 'approve1' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_answer_return_claim', { id: 'c1', action: 'rejectcustom', comment: 'Товар без дефектов' });
    expect(sent().data).toEqual({ id: 'c1', action: 'rejectcustom', comment: 'Товар без дефектов' });
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: {} });
    await call('wildberries_list_return_claims', { is_archive: false, limit: 200 });
    expect(sent().params).toEqual({ is_archive: false, limit: 200 });
  });

  it('reads are read-only, writes confirm first, the rejection is switched off', () => {
    for (const [name, , method] of table) {
      const ann = annotationsOf(tool(name));
      expect(`${name}:${ann.readOnlyHint}`).toBe(`${name}:${method === 'GET'}`);
      if (method !== 'GET') expect(`${name}:${/confirm/i.test(tool(name).description)}`).toBe(`${name}:true`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(['wildberries_reject_question']);
    expect(annotationsOf(tool('wildberries_answer_return_claim')).destructiveHint).toBe(true);
    expect(annotationsOf(tool('wildberries_answer_question')).destructiveHint).toBe(false);
  });

  it('warns about the Base token limit that made a workspace hit 429 on every other answer', () => {
    expect(a.instructions).toMatch(/only 5 an hour/);
    expect(tool('wildberries_answer_feedback').description).toMatch(/5 feedback or question calls an hour/);
  });

  it('only points the model at tools that exist, and the new text has no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const texts = [a.instructions, a.description, ...table.map(([n]) => JSON.stringify(tool(n)))];
    for (const s of texts) {
      for (const m of s.matchAll(/\bwildberries_[a-z_]+/g)) expect(names).toContain(m[0]);
      expect(s).not.toMatch(/[–—]/);
    }
  });
});
