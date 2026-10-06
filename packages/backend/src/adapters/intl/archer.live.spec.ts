import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as adapterJson from './archer.json';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { injectLoginTokenHeaders } from '../../connectors/engines/rest.engine';
import { interpolateDeep } from '../../common/env-interpolation.util';

jest.mock('axios');

/**
 * Archer IRM adapter: REST platform API (/api/core) and Content API
 * (/contentapi), session token from POST /api/core/security/login sent as
 * `Authorization: Archer session-id="..."`.
 *
 * Static only: Archer has no keyless endpoint.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Record<string, any>;
  annotations?: Record<string, unknown>;
  enabled?: boolean;
};
const adapter = adapterJson as unknown as {
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, any> };
  tools: Tool[];
};
const tool = (name: string) => adapter.tools.find((t) => t.name === name)!;

function reaches(t: Tool, param: string): boolean {
  const m = t.endpointMapping;
  if (String(m.path ?? '').includes(`{${param}}`)) return true;
  return Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) }).includes(`$${param}`);
}

describe('archer adapter (static)', () => {
  it('logs in with a session token', () => {
    expect(adapter.connector.authType).toBe('LOGIN_TOKEN');
    expect(adapter.connector.authConfig.loginUrl).toBe('{{ARCHER_URL}}/api/core/security/login');
    expect(adapter.connector.authConfig.tokenJsonPath).toBe('RequestedObject.SessionToken');
  });

  it('every tool is prefixed, described and sends every parameter', () => {
    for (const t of adapter.tools) {
      expect(t.name.startsWith('archer_')).toBe(true);
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, def] of Object.entries(t.parameters.properties ?? {})) {
        expect(def.description).toBeTruthy();
        expect({ tool: t.name, param: p, reaches: reaches(t, p) }).toEqual({ tool: t.name, param: p, reaches: true });
      }
    }
  });

  it('only reads: GETs, and the one POST read is flagged read-only with the GET override', () => {
    for (const t of adapter.tools) {
      if (t.endpointMapping.method === 'GET') continue;
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.endpointMapping.headers['X-Http-Method-Override']).toBe('GET');
    }
  });

  it('probe needs no arguments', () => {
    expect(tool(adapter.probe.tool).parameters.required ?? []).toEqual([]);
  });

  it('sends the login body and the Archer session header', async () => {
    const auth = interpolateDeep(adapter.connector.authConfig, {
      ARCHER_URL: 'https://example.archerirm.com',
      ARCHER_INSTANCE: '123456',
      ARCHER_USERNAME: 'api_user',
      ARCHER_PASSWORD: 'secret',
      ARCHER_USER_DOMAIN: '',
    }) as any;
    const mocked = axios as unknown as jest.Mock;
    mocked.mockResolvedValueOnce({
      data: { Links: [], RequestedObject: { SessionToken: 'ABC123', UserId: 7 }, IsSuccessful: true, ValidationMessages: [] },
      headers: {},
    });
    const config = { get: () => 'test-encryption-key-32-chars-ok!' } as unknown as ConfigService;
    const bundle = await new LoginTokenService({} as any, config).getToken(auth);
    const call = mocked.mock.calls[0][0];
    expect(call.url).toBe('https://example.archerirm.com/api/core/security/login');
    expect(call.data).toEqual({ InstanceName: '123456', Username: 'api_user', UserDomain: '', Password: 'secret' });
    const req: any = { headers: {} };
    injectLoginTokenHeaders(req, auth, bundle.token);
    expect(req.headers.Authorization).toBe('Archer session-id="ABC123"');
  });
});
