import * as adapter from './z-api.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
  responseMapping?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  instructions: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Z-API adapter: static contract', () => {
  it('puts instance ID and token in the base URL and sends the Client-Token header', () => {
    expect(a.requiredEnvVars).toEqual(['ZAPI_INSTANCE_ID', 'ZAPI_INSTANCE_TOKEN', 'ZAPI_CLIENT_TOKEN']);
    expect(a.connector.baseUrl).toBe(
      'https://api.z-api.io/instances/{{ZAPI_INSTANCE_ID}}/token/{{ZAPI_INSTANCE_TOKEN}}',
    );
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Client-Token', apiKey: '{{ZAPI_CLIENT_TOKEN}}' });
    expect(a.probe.tool).toBe('z_api_get_status');
  });

  it('refuses a pasted URL in the path variables and marks the tokens secret', () => {
    for (const name of ['ZAPI_INSTANCE_ID', 'ZAPI_INSTANCE_TOKEN', 'ZAPI_CLIENT_TOKEN']) {
      const re = new RegExp(a.envVarMeta[name].pattern!);
      expect(re.test('https://api.z-api.io/instances/x')).toBe(false);
      expect(re.test('../status')).toBe(false);
    }
    expect(new RegExp(a.envVarMeta.ZAPI_INSTANCE_ID.pattern!).test('3E98A1B2C3D4E5F6A7B8C9D0E1F5DDF')).toBe(true);
    expect(a.envVarMeta.ZAPI_INSTANCE_TOKEN.secret).toBe(true);
    expect(a.envVarMeta.ZAPI_CLIENT_TOKEN.secret).toBe(true);
  });

  it('maps every tool to a documented endpoint', () => {
    const routes = a.tools.map((t) => `${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`);
    expect(routes).toEqual([
      'z_api_get_status GET /status',
      'z_api_get_instance GET /me',
      'z_api_get_device GET /device',
      'z_api_check_phone_exists GET /phone-exists/{phone}',
      'z_api_list_chats GET /chats',
      'z_api_get_chat GET /chats/{phone}',
      'z_api_list_contacts GET /contacts',
      'z_api_list_queue POST /queue',
      'z_api_send_text POST /send-text',
      'z_api_send_image POST /send-image',
      'z_api_send_document POST /send-document/{extension}',
    ]);
    expect(a.tools.every((t) => t.name.startsWith('z_api_'))).toBe(true);
  });

  it('marks the POST queue listing read-only and asks for confirmation on every send', () => {
    expect(byName.z_api_list_queue.annotations).toEqual({ readOnlyHint: true });
    const sends = a.tools.filter((t) => t.name.startsWith('z_api_send_'));
    expect(sends).toHaveLength(3);
    for (const t of sends) {
      expect(t.endpointMapping.method).toBe('POST');
      expect(t.description).toMatch(/confirm the recipient/);
      expect(t.annotations).toBeUndefined();
    }
  });

  it('supplies the page and pageSize Z-API requires on list calls', () => {
    for (const name of ['z_api_list_chats', 'z_api_list_contacts']) {
      expect(byName[name].endpointMapping.queryParams).toEqual({ page: '$page', pageSize: '$pageSize' });
      expect(byName[name].parameters.properties!.page.default).toBe(1);
      expect(byName[name].parameters.properties!.pageSize.default).toEqual(expect.any(Number));
    }
  });

  it('never hands the instance token or proxy credentials from /me to the model', () => {
    const out = applyResponseTransform(
      {
        id: '123456',
        token: 'abcdef-ghij-klmn-opqr',
        name: 'My instance',
        due: 1700000000,
        connected: true,
        paymentStatus: 'ACTIVE',
        proxyUrl: 'socks5://user:pw@host:1080',
      },
      byName.z_api_get_instance.responseMapping,
    );
    expect(out.value).toEqual({ id: '123456', name: 'My instance', due: 1700000000, connected: true, paymentStatus: 'ACTIVE' });
  });

  it('states the phone format and the unofficial, QR-linked nature of the gateway', () => {
    expect(a.instructions).toContain('5511999999999');
    expect(a.instructions).toMatch(/not Meta's official WhatsApp Business API/);
    expect(a.instructions).toMatch(/QR code/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1000);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
  });
});

// Opt-in: RUN_Z_API_LIVE=1 with ZAPI_INSTANCE_ID, ZAPI_INSTANCE_TOKEN and ZAPI_CLIENT_TOKEN of a (trial) instance.
// Read-only: it never sends a message.
const live = process.env.RUN_Z_API_LIVE === '1';
(live ? describe : describe.skip)('Z-API: live read-only smoke test', () => {
  const base = () => {
    const id = process.env.ZAPI_INSTANCE_ID;
    const token = process.env.ZAPI_INSTANCE_TOKEN;
    const client = process.env.ZAPI_CLIENT_TOKEN;
    if (!id || !token || !client) {
      throw new Error('Set ZAPI_INSTANCE_ID, ZAPI_INSTANCE_TOKEN and ZAPI_CLIENT_TOKEN for RUN_Z_API_LIVE=1');
    }
    return { url: `https://api.z-api.io/instances/${id}/token/${token}`, client };
  };

  it('reads the connection status', async () => {
    const { url, client } = base();
    const response = await fetch(url + '/status', { headers: { 'Client-Token': client } });
    expect(response.status).toBe(200);
    expect(typeof (await response.json()).connected).toBe('boolean');
  });

  it('lists the first page of chats', async () => {
    const { url, client } = base();
    const response = await fetch(url + '/chats?page=1&pageSize=5', { headers: { 'Client-Token': client } });
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
