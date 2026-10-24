import * as adapter from './medmis.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * MEDMIS API v1 (Swagger at <node>/apix/swagger, spec at <node>/apix/swagger/v1/swagger.json; each clinic
 * runs on a node such as https://node3.medmis.ru). Sign-in: POST /apix/v1/Auth/login with login,
 * systemName and password returns a JWT accessToken (expiresIn seconds) sent as Bearer.
 * Reads only, plus three writes installed switched off; no DELETE route is mapped.
 * Live part: MEDMIS_URL=https://nodeN.medmis.ru MEDMIS_LOGIN=... MEDMIS_PASSWORD=... MEDMIS_SYSTEM_NAME=... RUN_MEDMIS_LIVE=1 npx jest src/adapters/intl/medmis
 * (reads only: branches, appointment statuses, today's appointments).
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
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
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
const PREFIX = 'medmis_';
const WRITES: string[] = ['medmis_create_appointment', 'medmis_update_appointment', 'medmis_create_task'];

describe('medmis adapter: static spec conformance', () => {
  it('signs in with login, system name and password and sends the access token as Bearer', () => {
    expect(a.requiredEnvVars).toEqual(['MEDMIS_URL', 'MEDMIS_LOGIN', 'MEDMIS_PASSWORD', 'MEDMIS_SYSTEM_NAME']);
    expect(a.connector.baseUrl).toBe('{{MEDMIS_URL}}/apix');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toMatchObject({
      loginUrl: '{{MEDMIS_URL}}/apix/v1/Auth/login',
      loginMethod: 'POST',
      loginBody: { login: '${username}', systemName: '${aud}', password: '${password}' },
      username: '{{MEDMIS_LOGIN}}',
      password: '{{MEDMIS_PASSWORD}}',
      aud: '{{MEDMIS_SYSTEM_NAME}}',
      tokenJsonPath: 'accessToken',
      expiryJsonPath: 'expiresIn',
      expiryFormat: 'ttl_seconds',
      refreshOn401: true,
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.envVarMeta?.MEDMIS_PASSWORD.secret).toBe(true);
    const url = new RegExp(a.envVarMeta?.MEDMIS_URL.pattern as string);
    expect(url.test('https://node3.medmis.ru')).toBe(true);
    expect(url.test('https://node3.medmis.ru/apix')).toBe(false);
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/v1/')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/Auth|Webhooks/);
  });

  it('maps the documented routes', () => {
    expect(tool('medmis_list_appointments').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/v1/Appointments',
      queryParams: { dateFrom: '$dateFrom', dateTo: '$dateTo', employeeIds: '$employeeIds', statusIds: '$statusIds', page: '$page', pageSize: '$pageSize' },
    });
    expect(tool('medmis_list_appointment_reference').endpointMapping.path).toBe('/v1/Appointments/{dictionary}');
    expect((tool('medmis_list_appointment_reference').parameters?.properties?.dictionary as { enum: string[] }).enum).toEqual(['statuses', 'types', 'visitations', 'sources', 'tags']);
    expect((tool('medmis_list_patient_reference').parameters?.properties?.dictionary as { enum: string[] }).enum).toEqual(['tags', 'attractions', 'identity_doc_types']);
    expect(tool('medmis_get_schedule_grid').endpointMapping).toMatchObject({ path: '/v1/Schedule/grid', queryParams: { branchIds: '$branchIds', dateFrom: '$dateFrom', dateTo: '$dateTo', onlyFreeSlots: '$onlyFreeSlots' } });
    expect(tool('medmis_get_schedule_grid').parameters?.required).toEqual(['branchIds', 'dateFrom', 'dateTo']);
    expect(tool('medmis_list_invoices').endpointMapping).toMatchObject({ path: '/v1/PatientInvoices', queryParams: { isPaid: '$isPaid', patientIds: '$patientIds' } });
    expect(tool('medmis_list_invoice_services').endpointMapping.path).toBe('/v1/PatientInvoices/{invoiceId}/services');
    expect(tool('medmis_list_payments').endpointMapping).toMatchObject({ path: '/v1/Payments', queryParams: { typeIds: '$typeIds', isFiscaled: '$isFiscaled' } });
    expect(tool('medmis_list_stores').endpointMapping.path).toBe('/v1/Store/{branchId}');
    expect(tool('medmis_get_stock_levels').endpointMapping.path).toBe('/v1/Store/rest');
    expect(tool('medmis_list_checkup_patients').endpointMapping.path).toBe('/v1/Profex/contract-patients');
    expect(tool('medmis_create_appointment').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/v1/Appointments',
      bodyMapping: { scheduleId: '$scheduleId', employeeSpecializationID: '$employeeSpecializationID', timeFrom: '$timeFrom', timeTo: '$timeTo', patientId: '$patientId' },
    });
    expect(tool('medmis_update_appointment').endpointMapping).toMatchObject({ method: 'PATCH', path: '/v1/Appointments/{appointmentId}', bodyMapping: { statusId: '$statusId' } });
    expect(tool('medmis_update_appointment').endpointMapping.bodyMapping).not.toHaveProperty('appointmentId');
    expect(tool('medmis_update_appointment').annotations?.destructiveHint).toBe(true);
    expect(tool('medmis_create_task').endpointMapping).toMatchObject({ method: 'POST', path: '/v1/Todo/tasks', bodyMapping: { name: '$name' } });
  });

  it('keeps identity numbers out of the patient and employee lists', () => {
    const patients = applyResponseTransform(
      { items: [{ id: 'p1', lastname: 'Ivanov', snils: '1', inn: '2', identityDocNum: '3', identityDocIssueAuthority: '4', mobilePhone: '7916' }], page: 1, totalCount: 1 },
      tool('medmis_list_patients').responseMapping as never,
    ).value;
    expect(patients).toEqual({ items: [{ id: 'p1', lastname: 'Ivanov', mobilePhone: '7916' }], page: 1, totalCount: 1 });
    const employees = applyResponseTransform({ items: [{ id: 'e1', name: 'Dr', snils: '1' }] }, tool('medmis_list_employees').responseMapping as never).value;
    expect(employees).toEqual({ items: [{ id: 'e1', name: 'Dr' }] });
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
    for (const t of a.tools) expect(t.endpointMapping.method).not.toBe('DELETE');
  });

  it('probes with a parameter-free read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});


const live =
  process.env.RUN_MEDMIS_LIVE === '1' && process.env.MEDMIS_URL && process.env.MEDMIS_LOGIN && process.env.MEDMIS_PASSWORD && process.env.MEDMIS_SYSTEM_NAME ? describe : describe.skip;
live('medmis adapter: live (read-only)', () => {
  const base = `${(process.env.MEDMIS_URL ?? '').replace(/\/$/, '')}/apix`;
  const pause = () => new Promise((r) => setTimeout(r, 1100));
  it('signs in and reads branches, appointment statuses and today\'s appointments', async () => {
    const login = await fetch(`${base}/v1/Auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ login: process.env.MEDMIS_LOGIN, systemName: process.env.MEDMIS_SYSTEM_NAME, password: process.env.MEDMIS_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const branches = (await (await fetch(`${base}/v1/Branches?pageSize=5`, { headers })).json()) as { items: unknown[]; totalCount: number };
    expect(Array.isArray(branches.items)).toBe(true);
    await pause();
    const statuses = (await (await fetch(`${base}/v1/Appointments/statuses`, { headers })).json()) as { items: unknown[] };
    expect(Array.isArray(statuses.items)).toBe(true);
    await pause();
    const day = new Date().toISOString().slice(0, 10);
    const appts = (await (await fetch(`${base}/v1/Appointments?dateFrom=${day}&dateTo=${day}&pageSize=5`, { headers })).json()) as { items: unknown[] };
    expect(Array.isArray(appts.items)).toBe(true);
  }, 60_000);
});
