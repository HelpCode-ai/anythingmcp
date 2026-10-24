import * as adapter from './klardaten.json';
import axios from 'axios';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { applyResponseTransform } from '../../connectors/response-transform.util';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

type Tool = {
  name: string;
  enabled?: boolean;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
  responseMapping?: Record<string, unknown>;
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  instructions: string;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
  };
  probe: { tool: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('klardaten adapter: static spec conformance', () => {
  it('api.klardaten.com with a Bearer API key', () => {
    expect(a.connector.baseUrl).toBe('https://api.klardaten.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{KLARDATEN_API_KEY}}');
  });

  it('sends the DATEV instance id on every request (required by the DATEV endpoints)', () => {
    expect(a.connector.headers['x-client-instance-id']).toBe('{{KLARDATEN_INSTANCE_ID}}');
    expect(a.requiredEnvVars).toEqual(['KLARDATEN_API_KEY', 'KLARDATEN_INSTANCE_ID']);
  });

  it('warns that the data is client tax and payroll data', () => {
    expect(a.instructions).toMatch(/Sensitive data/);
    expect(a.instructions).toMatch(/servers whose users are allowed to see/);
  });

  it('every tool is a GET except the document search and three writes, all installed switched off', () => {
    const offByDefault = [
      'klardaten_search_documents',
      'klardaten_update_order',
      'klardaten_create_expense_posting',
      'klardaten_set_client_responsibilities',
    ];
    for (const t of a.tools) {
      if (offByDefault.includes(t.name)) {
        expect(t.endpointMapping.method).not.toBe('GET');
        expect(t.enabled).toBe(false);
      } else {
        expect({ tool: t.name, method: t.endpointMapping.method }).toEqual({ tool: t.name, method: 'GET' });
      }
    }
  });

  it('sends the optional DATEV profile on every DATEVconnect call, and only when it is set', () => {
    const optional = (adapter as unknown as { optionalEnvVars: string[] }).optionalEnvVars;
    expect(optional).toEqual(['KLARDATEN_PROFILE_ID']);
    const datev = a.tools.filter((t) => t.endpointMapping.path.startsWith('/datevconnect/'));
    expect(datev.length).toBeGreaterThan(15);
    for (const t of datev) {
      // `${VAR}` (not `{{VAR}}`): the engine leaves the header out when the variable is empty.
      expect((t.endpointMapping as { headers?: Record<string, string> }).headers).toEqual({
        'x-profile-id': '${KLARDATEN_PROFILE_ID}',
      });
    }
  });

  it('writes go to the DATEVconnect paths a production integration uses', () => {
    expect(tool('klardaten_update_order').endpointMapping).toMatchObject({
      method: 'PUT',
      path: '/datevconnect/order-management/v1/orders/{order_id}',
      bodyTemplate: '${order}',
    });
    expect(tool('klardaten_create_expense_posting').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/datevconnect/order-management/v1/orders/{order_id}/suborders/{suborder_id}/expensepostings',
      queryParams: { automaticintegration: '$automatic_integration', deletemassdataonfailure: '$delete_mass_data_on_failure' },
    });
    expect(tool('klardaten_set_client_responsibilities').endpointMapping).toMatchObject({
      method: 'PUT',
      path: '/datevconnect/master-data/v1/clients/{client_id}/responsibilities',
      bodyTemplate: '${responsibilities}',
    });
  });

  it('reads DATEV Anwalt and user management under their DATEVconnect modules', () => {
    expect(tool('klardaten_list_law_files').endpointMapping.path).toBe('/datevconnect/law/v1/files');
    expect(tool('klardaten_list_law_catalog').endpointMapping.path).toBe('/datevconnect/law/v1/{catalog}');
    expect(tool('klardaten_list_datev_users').endpointMapping.path).toBe('/datevconnect/iam/v1/users');
    expect(tool('klardaten_get_datev_user').endpointMapping.path).toBe('/datevconnect/iam/v1/Users/{user_id}');
    expect(tool('klardaten_list_datev_groups').endpointMapping.path).toBe('/datevconnect/iam/v1/groups');
  });

  it('monitoring reads the configured instance from the path', () => {
    expect(tool('klardaten_get_datevconnect_health').endpointMapping.path).toBe(
      '/api/monitoring/instance/{{KLARDATEN_INSTANCE_ID}}/datev-connect-health',
    );
  });

  it('reads VAT returns like the other tax returns', () => {
    expect(tool('klardaten_list_vat_filings').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/api/tax/value-added-tax',
      queryParams: { page: '$page', page_size: '$page_size', order_by: '$order_by', fields: '$fields', filter: '$filter' },
    });
    expect(tool('klardaten_get_vat_filing').endpointMapping.path).toBe('/api/tax/value-added-tax/{id}');
    expect(tool('klardaten_get_vat_data').endpointMapping.path).toBe('/api/tax/value-added-tax/{id}/data');
    expect(tool('klardaten_list_clients_extended').endpointMapping).toMatchObject({
      path: '/api/master-data/clients/extended',
      queryParams: { filter: '$filter', order_by: '$order_by' },
    });
  });

  it('instance details, logs, metrics and audit logs read the configured instance', () => {
    const inst = '{{KLARDATEN_INSTANCE_ID}}';
    expect(tool('klardaten_get_instance').endpointMapping.path).toBe(`/api/client-instances/${inst}`);
    expect(tool('klardaten_get_instance_required_services').endpointMapping.path).toBe(
      `/api/client-instances/${inst}/required-services`,
    );
    expect(tool('klardaten_get_instance_metrics').endpointMapping.path).toBe(`/api/monitoring/instance/${inst}/metrics`);
    expect(tool('klardaten_list_instance_logs').endpointMapping).toMatchObject({
      path: `/api/monitoring/instance/${inst}/logs`,
      queryParams: { from_date: '$from_date', to_date: '$to_date', filter_pattern: '$filter_pattern', next_token: '$next_token', oldest_first: '$oldest_first' },
    });
    expect(tool('klardaten_list_audit_logs').endpointMapping.path).toBe(`/api/monitoring/instance/${inst}/audit-logs`);
    expect(tool('klardaten_get_audit_log').endpointMapping.path).toBe(
      `/api/monitoring/instance/${inst}/audit-logs/{log_name}/download`,
    );
  });

  it('removes the signing secret from the webhook lists', () => {
    const hooks = [{ id: 'w1', endpoint: 'https://example.com/hook', instance_id: 'i1', secret: 's3cr3t' }];
    for (const name of ['klardaten_list_data_change_webhooks', 'klardaten_list_monitoring_webhooks']) {
      const out = applyResponseTransform(hooks, tool(name).responseMapping as any).value as any[];
      expect(out).toEqual([{ id: 'w1', endpoint: 'https://example.com/hook', instance_id: 'i1' }]);
    }
  });

  it('the DATEVconnect passthrough forwards its query string verbatim', () => {
    const t = tool('klardaten_datevconnect_get');
    expect(t.endpointMapping.path).toBe('/datevconnect/{path}');
    expect(t.endpointMapping.queryParams).toEqual({ __rawquery: '$query' });
  });

  it('every path placeholder is a declared required parameter', () => {
    for (const t of a.tools) {
      const placeholders = [...t.endpointMapping.path.matchAll(/(?<!\{)\{([a-z_]+)\}(?!\})/g)].map((m) => m[1]);
      for (const p of placeholders) {
        expect(t.parameters.required ?? []).toContain(p);
      }
    }
  });

  it('probe is a cheap list call', () => expect(a.probe.tool).toBe('klardaten_list_clients'));
});

describe('klardaten adapter: requests', () => {
  const engine = new RestEngine(
    { getAccessToken: jest.fn(), refreshToken: jest.fn() } as any,
    { getToken: jest.fn(), forceRelogin: jest.fn() } as any,
  );
  const config = {
    baseUrl: 'https://api.klardaten.com',
    authType: 'BEARER_TOKEN' as const,
    authConfig: { token: 'uk-test' },
    headers: { 'x-client-instance-id': '48fa2446-c731-4a74-9ea7-b4bd6d66fe5f' },
  };
  const sent = () => mockedAxios.mock.calls[0][0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ status: 200, data: [], headers: {} });
  });

  it('leaves x-profile-id out when no profile is configured', async () => {
    await engine.execute(config, tool('klardaten_list_law_files').endpointMapping as any, { top: 5, KLARDATEN_PROFILE_ID: '' });
    expect(sent().url).toBe('https://api.klardaten.com/datevconnect/law/v1/files');
    expect(sent().params).toEqual({ top: 5 });
    expect(sent().headers).not.toHaveProperty('x-profile-id');
    expect(sent().headers['x-client-instance-id']).toBe('48fa2446-c731-4a74-9ea7-b4bd6d66fe5f');
  });

  it('fetches one audit log file with its name encoded into the path', async () => {
    const m = { ...(tool('klardaten_get_audit_log').endpointMapping as any) };
    m.path = m.path.replace('{{KLARDATEN_INSTANCE_ID}}', 'inst-1');
    await engine.execute(config, m, { log_name: 'audit 2026-10-20.log' });
    expect(sent().url).toBe('https://api.klardaten.com/api/monitoring/instance/inst-1/audit-logs/audit%202026-10-20.log/download');
  });

  it('sends the configured profile as x-profile-id', async () => {
    await engine.execute(config, tool('klardaten_list_datev_groups').endpointMapping as any, { KLARDATEN_PROFILE_ID: 'jdoe' });
    expect(sent().headers['x-profile-id']).toBe('jdoe');
  });

  it('sends the whole order object back on update', async () => {
    const order = { id: 42, completion_status: 'done', planned_hours_time_units: 2400 };
    await engine.execute(config, tool('klardaten_update_order').endpointMapping as any, { order_id: '42', order });
    expect(sent().method).toBe('PUT');
    expect(sent().url).toBe('https://api.klardaten.com/datevconnect/order-management/v1/orders/42');
    expect(sent().data).toEqual(order);
  });

  it('sends the responsibilities as a bare JSON array', async () => {
    const responsibilities = [{ area_of_responsibility_id: 'a1', employee_id: 'e1' }];
    await engine.execute(config, tool('klardaten_set_client_responsibilities').endpointMapping as any, {
      client_id: 'c-guid',
      responsibilities,
    });
    expect(sent().data).toEqual(responsibilities);
  });

  it('books a time entry with DATEV field names and the integration switch as a query parameter', async () => {
    await engine.execute(config, tool('klardaten_create_expense_posting').endpointMapping as any, {
      order_id: '42',
      suborder_id: '1',
      employee_id: 'emp-guid',
      work_date: '19.10.2026 00:00:00',
      cost_position: '9000',
      time_units: 1200,
      is_billable: true,
      automatic_integration: false,
    });
    expect(sent().url).toBe(
      'https://api.klardaten.com/datevconnect/order-management/v1/orders/42/suborders/1/expensepostings',
    );
    expect(sent().params).toEqual({ automaticintegration: false });
    expect(sent().data).toEqual({
      employee_id: 'emp-guid',
      work_date: '19.10.2026 00:00:00',
      cost_position: '9000',
      time_units: 1200,
      isbillable: true,
    });
  });
});
