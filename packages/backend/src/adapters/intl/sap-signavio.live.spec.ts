import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as adapterJson from './sap-signavio.json';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { injectLoginTokenHeaders } from '../../connectors/engines/rest.engine';
import { interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios');

/**
 * SAP Signavio Process Manager adapter: the /p/ API of the workspace host,
 * session login (POST /p/login with tokenonly=true) whose JSESSIONID cookie
 * and x-signavio-id token travel on every call.
 *
 * Static only: there is no keyless endpoint, and a live run needs a user of
 * a real workspace.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const adapter = adapterJson as unknown as {
  probe: { tool: string };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) }).includes(`$${param}`);
}

describe('sap-signavio adapter (static)', () => {
  it('targets the Process Manager /p/ API with a session login', () => {
    expect(adapter.connector.type).toBe('REST');
    expect(adapter.connector.baseUrl).toBe('{{SIGNAVIO_URL}}/p');
    expect(adapter.connector.authType).toBe('LOGIN_TOKEN');
    expect(adapter.connector.authConfig.loginUrl).toBe('{{SIGNAVIO_URL}}/p/login');
    expect(adapter.connector.headers.Accept).toBe('application/json');
  });

  it('only reads, every tool is prefixed, described and sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('sap_signavio_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      expect(t.endpointMapping.method).toBe('GET');
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('probe needs no arguments', () => {
    expect(tool(adapter.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('returns BPMN exports as XML text', () => {
    expect(tool('sap_signavio_export_model_bpmn').endpointMapping.rawBody).toBe(true);
    expect(tool('sap_signavio_get_revision_bpmn').endpointMapping.rawBody).toBe(true);
  });

  it('logs in form-encoded and sends JSESSIONID plus x-signavio-id', async () => {
    const auth = interpolateDeep(adapter.connector.authConfig, {
      SIGNAVIO_URL: 'https://editor.signavio.com',
      SIGNAVIO_EMAIL: 'api@example.com',
      SIGNAVIO_PASSWORD: 'secret',
      SIGNAVIO_WORKSPACE_ID: 'ws1',
    }) as any;
    const mocked = axios as unknown as jest.Mock;
    mocked.mockResolvedValueOnce({
      data: 'abc123token',
      headers: { 'set-cookie': ['JSESSIONID=SESSION42; Path=/; Secure; HttpOnly', 'LBROUTEID=.n1; Path=/'] },
    });
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const call = mocked.mock.calls[0][0];
    expect(call.url).toBe('https://editor.signavio.com/p/login');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.data).toEqual({ name: 'api@example.com', password: 'secret', tokenonly: 'true', tenant: 'ws1' });
    expect(bundle.token).toBe('SESSION42');
    expect(bundle.aud).toBe('abc123token');

    const req: any = { headers: {} };
    injectLoginTokenHeaders(req, auth, bundle.token, bundle.aud);
    expect(req.headers).toEqual({ Cookie: 'JSESSIONID=SESSION42', 'x-signavio-id': 'abc123token' });
  });
});
