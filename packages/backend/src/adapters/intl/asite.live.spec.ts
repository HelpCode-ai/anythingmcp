import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as adapterJson from './asite.json';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { injectLoginTokenHeaders } from '../../connectors/engines/rest.engine';
import { interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios');

/**
 * Asite adapter: DMS host (/api/...) and Adoddle host (/commonapi/...),
 * session id from POST /apilogin/ sent as the ASessionID cookie and header.
 *
 * Static only: Asite has no keyless endpoint.
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
  connector: { baseUrl: string; authType: string; authConfig: Record<string, any>; headers: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) }).includes(`$${param}`);
}

describe('asite adapter (static)', () => {
  it('logs in on the DMS host', () => {
    expect(adapter.connector.baseUrl).toBe('{{ASITE_DMS_URL}}');
    expect(adapter.connector.authType).toBe('LOGIN_TOKEN');
    expect(adapter.connector.authConfig.loginUrl).toBe('{{ASITE_DMS_URL}}/apilogin/');
    expect(adapter.connector.headers.Accept).toBe('application/json');
  });

  it('every tool is prefixed, described and sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('asite_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('only reads; POST searches are form-encoded and flagged read-only', () => {
    for (const t of adapter.tools) {
      if (t.endpointMapping.method === 'GET') continue;
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.endpointMapping.bodyEncoding).toBe('form-urlencoded');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('sends /commonapi calls to the Adoddle host, /api calls to the DMS host', () => {
    for (const t of adapter.tools) {
      const path = String(t.endpointMapping.path);
      if (path.includes('/commonapi/')) expect(path.startsWith('{{ASITE_ADODDLE_URL}}/commonapi/')).toBe(true);
      else expect(path.startsWith('/api/')).toBe(true);
    }
  });

  it('probe needs no arguments', () => {
    expect(tool(adapter.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('logs in form-encoded asking for JSON and sends the session id', async () => {
    const auth = interpolateDeep(adapter.connector.authConfig, {
      ASITE_DMS_URL: 'https://dms.asite.com',
      ASITE_EMAIL: 'api@example.com',
      ASITE_PASSWORD: 'secret',
    }) as any;
    const mocked = axios as unknown as jest.Mock;
    mocked.mockResolvedValueOnce({
      data: { UserProfile: { User_Name: 'API', SessionTimeoutDuration: 150, Sessionid: 'S3ss10n=' } },
      headers: {},
    });
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const call = mocked.mock.calls[0][0];
    expect(call.url).toBe('https://dms.asite.com/apilogin/');
    expect(call.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    expect(call.data).toEqual({ emailId: 'api@example.com', password: 'secret' });
    const req: any = { headers: {} };
    injectLoginTokenHeaders(req, auth, bundle.token);
    expect(req.headers).toEqual({ Cookie: 'ASessionID=S3ss10n=', ASessionID: 'S3ss10n=' });
  });
});
