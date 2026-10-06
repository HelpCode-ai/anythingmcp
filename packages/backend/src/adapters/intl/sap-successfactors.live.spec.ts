import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as adapterJson from './sap-successfactors.json';
import { ODataEngine } from '../../connectors/engines/odata.engine';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { buildODataBuiltinTools, odataToolPrefix } from '../../connectors/odata/odata-builtins';
import { renderStaticResponse } from '../../connectors/static-response.util';
import { interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios');

/**
 * SAP SuccessFactors adapter: OData V2 with OAuth 2.0 SAML bearer
 * (LOGIN_TOKEN against /oauth/token).
 *
 * Static only. There is no keyless SuccessFactors endpoint, and a live run
 * needs an OAuth client plus a signed SAML assertion of a real tenant.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Record<string, any>;
};
const adapter = adapterJson as unknown as {
  slug: string;
  name: string;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, any>; config: { odata: Record<string, unknown> } };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

/** Every declared parameter has to reach the request. */
function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (m.method === 'static') return true;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) }).includes(`$${param}`);
}

describe('sap-successfactors adapter (static)', () => {
  it('is an OData V2 connector on /odata/v2 with SAML bearer login', () => {
    expect(adapter.connector.type).toBe('ODATA');
    expect(adapter.connector.baseUrl).toBe('{{SF_API_URL}}/odata/v2');
    expect(adapter.connector.authType).toBe('LOGIN_TOKEN');
    expect(adapter.connector.authConfig.loginUrl).toBe('{{SF_API_URL}}/oauth/token');
    expect(adapter.connector.authConfig.loginBody.grant_type).toBe('urn:ietf:params:oauth:grant-type:saml2-bearer');
    expect(adapter.connector.config.odata.version).toBe('v2');
  });

  it('gets the five OData built-ins under its own prefix, without clashing', () => {
    const prefix = odataToolPrefix({ toolPrefix: adapter.connector.config.odata.toolPrefix as string, name: adapter.slug });
    expect(prefix).toBe('sap_successfactors');
    const builtins = buildODataBuiltinTools({ prefix, displayName: adapter.name, sap: false }).map((t) => t.name);
    expect(builtins).toEqual(expect.arrayContaining(['sap_successfactors_query', 'sap_successfactors_describe_entity']));
    const own = adapter.tools.map((t) => t.name);
    expect(builtins.filter((n) => own.includes(n))).toEqual([]);
  });

  it('every tool is prefixed, described, and sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('sap_successfactors_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('probe is a read with no required parameters', () => {
    const probe = tool(adapter.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters.required ?? []).toEqual([]);
  });

  it('answers every guide topic', () => {
    const guide = tool('sap_successfactors_guide');
    for (const topic of (guide.parameters.properties!.topic as any).enum) {
      expect(renderStaticResponse(guide.endpointMapping as any, { topic })).not.toMatch(/^There is no topic/);
    }
  });

  it('sends an effective-dated read as OData V2 JSON with asOfDate', async () => {
    const executeWithMeta = jest.fn().mockResolvedValue({ body: { d: { results: [{ userId: 'u1' }], __count: '1' } }, headers: {} });
    const engine = new ODataEngine({ executeWithMeta } as any);
    const out: any = await engine.execute(
      { baseUrl: 'https://api4.successfactors.com/odata/v2', authType: 'LOGIN_TOKEN' },
      tool('sap_successfactors_list_employee_jobs').endpointMapping,
      { top: 5, filter: "department eq 'SALES'", as_of_date: '2026-01-01' },
      adapter.connector.config.odata,
    );
    expect(out.rows).toEqual([{ userId: 'u1' }]);
    const [, mapping, params] = executeWithMeta.mock.calls[0];
    expect(mapping.path).toBe('/EmpJob');
    expect(mapping.queryParams).toMatchObject({ $format: 'json', asOfDate: '$as_of_date', $filter: '$filter', $top: '$top' });
    expect(params).toMatchObject({ as_of_date: '2026-01-01', top: 5 });
  });

  it('exchanges the SAML assertion for a bearer token, form-encoded', async () => {
    const auth = interpolateDeep(adapter.connector.authConfig, {
      SF_API_URL: 'https://api4.successfactors.com',
      SF_COMPANY_ID: 'ACME',
      SF_CLIENT_ID: 'client-key',
      SF_SAML_ASSERTION: 'PHNhbWw+',
    }) as any;
    const mocked = axios as unknown as jest.Mock;
    mocked.mockResolvedValueOnce({ data: { access_token: 'tok', token_type: 'Bearer', expires_in: 86399 }, headers: {} });
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    const svc = new LoginTokenService({} as any, config);
    const bundle = await svc.getToken(auth);
    expect(bundle.token).toBe('tok');
    const call = mocked.mock.calls[0][0];
    expect(call.url).toBe('https://api4.successfactors.com/oauth/token');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.data).toEqual({
      client_id: 'client-key',
      company_id: 'ACME',
      grant_type: 'urn:ietf:params:oauth:grant-type:saml2-bearer',
      assertion: 'PHNhbWw+',
    });
    expect(bundle.expiresAt - Date.now()).toBeGreaterThan(86000 * 1000);
  });
});
