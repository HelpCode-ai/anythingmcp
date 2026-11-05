import axios from 'axios';
import * as adapter from './factorial-hr.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Factorial HR adapter:
 *
 *   1. Static: always runs without credentials. Pins the x-api-key header,
 *      every tool's HTTP method, URL path, query and path parameters through
 *      the real RestEngine, checked against the Factorial HR API version
 *      2026-10-01 OpenAPI specification. Also verifies read-only annotations,
 *      parameter schemas, and cursor pagination metadata.
 *
 *   2. Live: skipped unless RUN_FACTORIAL_HR_LIVE=1.
 *      Checks that real endpoints reject a fake key with 401.
 *      With a valid FACTORIAL_API_KEY, reads employees and teams.
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
  enabled?: boolean;
  parameters: {
    type?: string;
    properties?: Record<string, { description?: string; default?: unknown; type?: string; items?: unknown }>;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  slug: string;
  name: string;
  description: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: {
    name: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers?: Record<string, string>;
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  });

const HOST = 'https://api.factorialhr.com';
const FAKE_KEY = 'factorial_api_key_0123456789abcdef';
const ENV: Record<string, string> = { FACTORIAL_API_KEY: FAKE_KEY };
const EMPLOYEE_ID = '12345';

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};

const sent = () => mockedAxios.mock.calls[0][0];

describe('factorial-hr adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and configured with the official API 2026-10-01 specifications', () => {
    expect(a.slug).toBe('factorial-hr');
    expect(a.name).toBe('Factorial HR');
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('hr');
    expect(a.icon).toBe('factorial-hr');
    expect(a.docsUrl).toBe('https://apidoc.factorialhr.com');
  });

  it('sends the API key as x-api-key header to api.factorialhr.com', () => {
    expect(a.connector.baseUrl).toBe(HOST);
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({
      headerName: 'x-api-key',
      apiKey: '{{FACTORIAL_API_KEY}}',
    });
    expect(a.probe).toEqual({
      tool: 'factorial_hr_list_employees',
      params: { limit: 1 },
    });
    expect(a.requiredEnvVars).toEqual(['FACTORIAL_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.FACTORIAL_API_KEY).toMatchObject({
      kind: 'credential',
      secret: true,
      required: true,
    });
    for (const key of ['401', '403', '429']) {
      expect(a.verifyHints[key]).toBeTruthy();
    }
  });

  it('prefixes every tool with factorial_hr_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(5);
    for (const name of mine) {
      expect(name).toMatch(/^factorial_hr_[a-z_]+$/);
    }
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) {
        expect(mine.has(t.name)).toBe(false);
      }
    }
  });

  it('all five tools are strictly read-only GET operations', () => {
    expect(a.tools).toHaveLength(5);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      const annotations = annotationsOf(t);
      expect(annotations.readOnlyHint).toBe(true);
      expect(annotations.destructiveHint).toBe(false);
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['factorial_hr_list_employees', {}, 'GET', '/api/2026-10-01/resources/employees/employees'],
    ['factorial_hr_get_employee', { id: EMPLOYEE_ID }, 'GET', `/api/2026-10-01/resources/employees/employees/${EMPLOYEE_ID}`],
    ['factorial_hr_list_teams', {}, 'GET', '/api/2026-10-01/resources/teams/teams'],
    ['factorial_hr_list_leaves', {}, 'GET', '/api/2026-10-01/resources/timeoff/leaves'],
    ['factorial_hr_list_shifts', {}, 'GET', '/api/2026-10-01/resources/attendance/shifts'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with x-api-key header', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${path}`);
    expect(req.headers['x-api-key']).toBe(FAKE_KEY);
  });

  it('list_employees serializes documented query parameters including only_active filter and arrays', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_employees', {
      limit: 50,
      after_id: 'cursor_abc',
      only_active: true,
      only_managers: false,
      full_text_name: 'Jane Doe',
      name_starts_with: 'Jane',
      ids: ['10', '20'],
      emails: ['jane@example.com'],
      team_ids: ['1', '2'],
    });
    expect(sent().params).toEqual({
      limit: 50,
      after_id: 'cursor_abc',
      only_active: true,
      only_managers: false,
      full_text_name: 'Jane Doe',
      name_starts_with: 'Jane',
      'ids[]': ['10', '20'],
      'emails[]': ['jane@example.com'],
      'team_ids[]': ['1', '2'],
    });
  });

  it('list_teams serializes team query parameters and pagination', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_teams', {
      limit: 25,
      after_id: 'cursor_teams',
      ids: ['3', '4'],
    });
    expect(sent().params).toEqual({
      limit: 25,
      after_id: 'cursor_teams',
      'ids[]': ['3', '4'],
    });
  });

  it('list_leaves serializes employee_ids[], date window, and approval filters with schema defaults', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_leaves', {
      limit: 30,
      employee_ids: ['101', '102'],
      ids: ['55'],
      from: '2026-01-01',
      to: '2026-12-31',
      approved: true,
      only_active: true,
    });
    expect(sent().params).toEqual({
      limit: 30,
      'employee_ids[]': ['101', '102'],
      'ids[]': ['55'],
      from: '2026-01-01',
      to: '2026-12-31',
      approved: true,
      only_active: true,
      include_deleted_leaves: false,
      include_duration: false,
      include_duration_by_day: false,
    });
  });

  it('list_leaves serializes explicit include_deleted_leaves boolean parameter', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_leaves', {
      limit: 10,
      include_deleted_leaves: true,
    });
    expect(sent().params).toEqual({
      limit: 10,
      include_deleted_leaves: true,
      include_duration: false,
      include_duration_by_day: false,
    });
  });

  it('list_leaves serializes duration query parameters with defaults false and explicit true values', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_leaves', {
      limit: 15,
      include_duration: true,
      include_duration_by_day: true,
    });
    expect(sent().params).toEqual({
      limit: 15,
      include_deleted_leaves: false,
      include_duration: true,
      include_duration_by_day: true,
    });
  });

  it('list_shifts serializes employee_ids[] and date window parameters with schema defaults', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_shifts', {
      limit: 20,
      employee_ids: ['201', '202'],
      ids: ['99'],
      start_on: '2026-10-01',
      end_on: '2026-10-31',
    });
    expect(sent().params).toEqual({
      limit: 20,
      'employee_ids[]': ['201', '202'],
      'ids[]': ['99'],
      start_on: '2026-10-01',
      end_on: '2026-10-31',
      half_day: false,
      sort_created_at_asc: true,
    });
  });

  it('list_shifts serializes explicit half_day and sort_created_at_asc parameters', async () => {
    mockedAxios.mockResolvedValue({ data: { data: [], meta: {} } });
    await call('factorial_hr_list_shifts', {
      limit: 15,
      half_day: true,
      sort_created_at_asc: false,
    });
    expect(sent().params).toEqual({
      limit: 15,
      half_day: true,
      sort_created_at_asc: false,
    });
  });

  it('response mapping excludes sensitive employee PII and banking data while preserving pagination metadata', () => {
    const raw = {
      data: [
        {
          id: 101,
          first_name: 'Jane',
          last_name: 'Doe',
          full_name: 'Jane Doe',
          email: 'jane@company.com',
          active: true,
          role: 'Engineer',
          bank_number: 'ES9121000418450200051332',
          swift_bic: 'CAIXESBBXXX',
          bank_number_format: 'iban',
          social_security_number: '281234567840',
          address_line_1: 'Carrer de Pujades 100',
          address_line_2: 'Piso 2',
          postal_code: '08005',
          personal_email: 'jane.personal@example.com',
          contact_number: '+34600000000',
          disability_percentage_cents: 0,
        },
      ],
      meta: {
        start_cursor: 'cur_start',
        end_cursor: 'cur_end',
        has_next_page: true,
        has_previous_page: false,
        limit: 20,
        total: 100,
      },
    };

    const out = applyResponseTransform(raw, tool('factorial_hr_list_employees').responseMapping as any).value as any;

    expect(out.meta).toEqual(raw.meta);
    expect(out.data[0].id).toBe(101);
    expect(out.data[0].full_name).toBe('Jane Doe');
    expect(out.data[0].email).toBe('jane@company.com');
    expect(out.data[0].active).toBe(true);

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ES9121000418450200051332');
    expect(serialized).not.toContain('CAIXESBBXXX');
    expect(serialized).not.toContain('281234567840');
    expect(serialized).not.toContain('Carrer de Pujades');
    expect(serialized).not.toContain('jane.personal@example.com');
    expect(serialized).not.toContain('+34600000000');
    expect(out.data[0]).not.toHaveProperty('bank_number');
    expect(out.data[0]).not.toHaveProperty('swift_bic');
    expect(out.data[0]).not.toHaveProperty('bank_number_format');
    expect(out.data[0]).not.toHaveProperty('social_security_number');
    expect(out.data[0]).not.toHaveProperty('address_line_1');
    expect(out.data[0]).not.toHaveProperty('address_line_2');
    expect(out.data[0]).not.toHaveProperty('postal_code');
    expect(out.data[0]).not.toHaveProperty('personal_email');
    expect(out.data[0]).not.toHaveProperty('contact_number');
    expect(out.data[0]).not.toHaveProperty('disability_percentage_cents');
  });

  it('response mapping excludes sensitive employee PII on single employee lookup', () => {
    const raw = {
      id: 101,
      first_name: 'Jane',
      last_name: 'Doe',
      full_name: 'Jane Doe',
      email: 'jane@company.com',
      active: true,
      bank_number: 'ES9121000418450200051332',
      swift_bic: 'CAIXESBBXXX',
      bank_number_format: 'iban',
      social_security_number: '281234567840',
      address_line_1: 'Carrer de Pujades 100',
      address_line_2: 'Piso 2',
      postal_code: '08005',
      personal_email: 'jane.personal@example.com',
      contact_number: '+34600000000',
      disability_percentage_cents: 0,
    };

    const out = applyResponseTransform(raw, tool('factorial_hr_get_employee').responseMapping as any).value as any;

    expect(out.id).toBe(101);
    expect(out.full_name).toBe('Jane Doe');
    expect(out.email).toBe('jane@company.com');

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ES9121000418450200051332');
    expect(serialized).not.toContain('CAIXESBBXXX');
    expect(serialized).not.toContain('281234567840');
    expect(serialized).not.toContain('Carrer de Pujades');
    expect(serialized).not.toContain('jane.personal@example.com');
    expect(out).not.toHaveProperty('bank_number');
    expect(out).not.toHaveProperty('swift_bic');
    expect(out).not.toHaveProperty('bank_number_format');
    expect(out).not.toHaveProperty('social_security_number');
    expect(out).not.toHaveProperty('address_line_1');
    expect(out).not.toHaveProperty('address_line_2');
    expect(out).not.toHaveProperty('postal_code');
    expect(out).not.toHaveProperty('personal_email');
    expect(out).not.toHaveProperty('contact_number');
    expect(out).not.toHaveProperty('disability_percentage_cents');
  });

  it('response mapping excludes precise GPS coordinates from shifts response', () => {
    const raw = {
      data: [
        {
          id: 501,
          employee_id: 101,
          date: '2026-10-15',
          clock_in: '09:00:00',
          clock_out: '17:00:00',
          half_day: false,
          in_location_latitude: 41.3851,
          in_location_longitude: 2.1734,
          in_location_accuracy: 10,
          out_location_latitude: 41.3852,
          out_location_longitude: 2.1735,
          out_location_accuracy: 12,
        },
      ],
      meta: {
        start_cursor: 'cur_s',
        end_cursor: 'cur_e',
        has_next_page: false,
        has_previous_page: false,
        limit: 20,
        total: 1,
      },
    };

    const out = applyResponseTransform(raw, tool('factorial_hr_list_shifts').responseMapping as any).value as any;

    expect(out.meta).toEqual(raw.meta);
    expect(out.data[0].id).toBe(501);
    expect(out.data[0].clock_in).toBe('09:00:00');
    expect(out.data[0].clock_out).toBe('17:00:00');
    expect(out.data[0]).not.toHaveProperty('in_location_latitude');
    expect(out.data[0]).not.toHaveProperty('in_location_longitude');
    expect(out.data[0]).not.toHaveProperty('in_location_accuracy');
    expect(out.data[0]).not.toHaveProperty('out_location_latitude');
    expect(out.data[0]).not.toHaveProperty('out_location_longitude');
    expect(out.data[0]).not.toHaveProperty('out_location_accuracy');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('41.3851');
    expect(serialized).not.toContain('2.1734');
  });

  it('response mapping preserves useful team hierarchy fields and all six pagination metadata fields', () => {
    const raw = {
      data: [
        {
          id: 10,
          name: 'Engineering',
          description: 'Product Engineering and Core Infrastructure',
          parent_team_id: null,
          parent_id: 999,
          depth: 1,
          company_id: 42,
          lead_ids: ['101'],
          employee_ids: ['101', '102', '103'],
          sensitive_internal_token: 'tok_secret_team_123',
        },
        {
          id: 11,
          name: 'Frontend',
          description: 'Web and Mobile Applications',
          parent_team_id: 10,
          parent_id: 10,
          depth: 2,
          company_id: 42,
          lead_ids: ['102'],
          employee_ids: ['102', '104'],
        },
      ],
      meta: {
        start_cursor: 'cur_team_start',
        end_cursor: 'cur_team_end',
        has_next_page: true,
        has_previous_page: false,
        limit: 20,
        total: 2,
      },
    };

    const out = applyResponseTransform(raw, tool('factorial_hr_list_teams').responseMapping as any).value as any;

    expect(out.meta).toEqual({
      start_cursor: 'cur_team_start',
      end_cursor: 'cur_team_end',
      has_next_page: true,
      has_previous_page: false,
      limit: 20,
      total: 2,
    });
    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toEqual({
      id: 10,
      name: 'Engineering',
      description: 'Product Engineering and Core Infrastructure',
      parent_team_id: null,
      depth: 1,
      company_id: 42,
      lead_ids: ['101'],
      employee_ids: ['101', '102', '103'],
    });
    expect(out.data[0]).not.toHaveProperty('parent_id');
    expect(out.data[0]).not.toHaveProperty('sensitive_internal_token');
    expect(out.data[1]).toEqual({
      id: 11,
      name: 'Frontend',
      description: 'Web and Mobile Applications',
      parent_team_id: 10,
      depth: 2,
      company_id: 42,
      lead_ids: ['102'],
      employee_ids: ['102', '104'],
    });
    expect(out.data[1]).not.toHaveProperty('parent_id');
  });

  it('response mapping preserves useful leave request details and all six pagination metadata fields', () => {
    const raw = {
      data: [
        {
          id: 301,
          employee_id: 101,
          company_id: 42,
          leave_type_id: 7,
          start_on: '2026-12-20',
          finish_on: '2026-12-31',
          half_day: null,
          approved: true,
          approval_status: 'approved',
          duration: 10,
          days_taken: 10,
          duration_attributes: { days: 10 },
          duration_by_day_attributes: [{ date: '2026-12-20', minutes: 480 }],
          hours_amount_in_cents: 8000,
          employee_full_name: 'Jane Doe',
          leave_type_name: 'Annual Vacation',
          start_time: '09:00:00',
          created_at: '2026-11-01T09:00:00Z',
          updated_at: '2026-11-02T14:30:00Z',
          deleted_at: null,
          description: 'Personal year-end trip with family',
          reason: 'Confidential medical recovery procedure',
          private_medical_condition: 'confidential notes',
          internal_payroll_code: 'PR-999',
        },
      ],
      meta: {
        start_cursor: 'cur_leave_start',
        end_cursor: 'cur_leave_end',
        has_next_page: false,
        has_previous_page: true,
        limit: 20,
        total: 1,
      },
    };

    const out = applyResponseTransform(raw, tool('factorial_hr_list_leaves').responseMapping as any).value as any;

    expect(out.meta).toEqual({
      start_cursor: 'cur_leave_start',
      end_cursor: 'cur_leave_end',
      has_next_page: false,
      has_previous_page: true,
      limit: 20,
      total: 1,
    });
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toEqual({
      id: 301,
      employee_id: 101,
      company_id: 42,
      leave_type_id: 7,
      start_on: '2026-12-20',
      finish_on: '2026-12-31',
      half_day: null,
      approved: true,
      days_taken: 10,
      duration_attributes: { days: 10 },
      duration_by_day_attributes: [{ date: '2026-12-20', minutes: 480 }],
      hours_amount_in_cents: 8000,
      employee_full_name: 'Jane Doe',
      leave_type_name: 'Annual Vacation',
      start_time: '09:00:00',
      created_at: '2026-11-01T09:00:00Z',
      updated_at: '2026-11-02T14:30:00Z',
      deleted_at: null,
    });
    expect(out.data[0].company_id).toBe(42);
    expect(out.data[0]).not.toHaveProperty('parent_id');
    expect(out.data[0]).not.toHaveProperty('approval_status');
    expect(out.data[0]).not.toHaveProperty('duration');
    expect(out.data[0]).not.toHaveProperty('description');
    expect(out.data[0]).not.toHaveProperty('reason');
    expect(out.data[0]).not.toHaveProperty('private_medical_condition');
    expect(out.data[0]).not.toHaveProperty('internal_payroll_code');
  });

  it('documents pagination clearly and adheres to description length standards', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.instructions).toContain('FACTORIAL_API_KEY');
    expect(a.instructions).toContain('x-api-key');
    expect(a.instructions).toContain('after_id = meta.end_cursor');

    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [_p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(typeof schema.description).toBe('string');
        expect(schema.description!.length).toBeGreaterThan(0);
      }
    }

    // Verify list tools document cursor pagination
    for (const name of ['factorial_hr_list_employees', 'factorial_hr_list_teams', 'factorial_hr_list_leaves', 'factorial_hr_list_shifts']) {
      expect(tool(name).description).toContain('after_id = meta.end_cursor');
      expect(tool(name).description).toContain('meta.has_next_page');
    }

    // No typographical em dashes or en dashes in JSON
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });
});

const live = process.env.RUN_FACTORIAL_HR_LIVE === '1' ? describe : describe.skip;
live('factorial-hr adapter: live', () => {
  const real = !!process.env.FACTORIAL_API_KEY;
  const env = () => ({ FACTORIAL_API_KEY: process.env.FACTORIAL_API_KEY! });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each([
    ['factorial_hr_list_employees', { limit: 1 }],
    ['factorial_hr_get_employee', { id: EMPLOYEE_ID }],
    ['factorial_hr_list_teams', { limit: 1 }],
    ['factorial_hr_list_leaves', { limit: 1 }],
    ['factorial_hr_list_shifts', { limit: 1 }],
  ])('%s reaches Factorial and is refused with a wrong key (401)', async (name, params) => {
    await expect(call(name, params)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  (real ? it : it.skip)('reads employees and teams with real credentials', async () => {
    const employees = await call('factorial_hr_list_employees', { limit: 2 }, env());
    expect(employees.data).toBeDefined();
    expect(employees.meta).toBeDefined();
    const teams = await call('factorial_hr_list_teams', { limit: 2 }, env());
    expect(teams.data).toBeDefined();
    expect(teams.meta).toBeDefined();
  }, 60000);
});
