import * as adapter from './wassenger.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

type Tool = {
  name: string;
  description: string;
  parameters: { required?: string[] };
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

describe('Wassenger adapter: static contract', () => {
  it('sends the API key in the Token header', () => {
    expect(a.requiredEnvVars).toEqual(['WASSENGER_API_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.wassenger.com/v1');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Token', apiKey: '{{WASSENGER_API_TOKEN}}' });
    expect(a.envVarMeta.WASSENGER_API_TOKEN.secret).toBe(true);
    expect(a.probe.tool).toBe('wassenger_list_numbers');
  });

  it('maps every tool to a documented endpoint', () => {
    const routes = a.tools.map((t) => `${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`);
    expect(routes).toEqual([
      'wassenger_list_numbers GET /devices',
      'wassenger_get_number_health GET /devices/{device_id}/health',
      'wassenger_check_number POST /numbers/exists',
      'wassenger_send_message POST /messages',
      'wassenger_get_message GET /messages/{message_id}',
      'wassenger_search_sent_messages GET /messages',
      'wassenger_get_message_ack_info GET /chat/{device_id}/messages/{message_wid}/ackinfo',
      'wassenger_list_chats GET /chat/{device_id}/chats',
      'wassenger_get_chat_messages GET /chat/{device_id}/messages',
      'wassenger_list_contacts GET /chat/{device_id}/contacts',
      'wassenger_get_contact GET /chat/{device_id}/contacts/{contact_wid}',
    ]);
    expect(a.tools.every((t) => t.name.startsWith('wassenger_'))).toBe(true);
  });

  it('has exactly one write, and the POST number check is read-only', () => {
    expect(byName.wassenger_check_number.annotations).toEqual({ readOnlyHint: true });
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET' && !t.annotations?.readOnlyHint);
    expect(writes.map((t) => t.name)).toEqual(['wassenger_send_message']);
    expect(byName.wassenger_send_message.description).toMatch(/confirm the recipient/);
    expect(byName.wassenger_send_message.endpointMapping.bodyMapping).toEqual({
      phone: '$phone',
      group: '$group',
      message: '$message',
      device: '$device',
      reference: '$reference',
    });
  });

  it('trims the large device documents to what identifies a number and its state', () => {
    const out = applyResponseTransform(
      [
        {
          id: '61b37a069cba0c15d6c81000',
          phone: '+447911123456',
          alias: 'Support',
          connector: 'web',
          session: { status: 'online', appVersion: '2.3' },
          billing: { subscription: { plan: 'gateway-basic', status: 'active', usage: { textMessages: 9 } } },
          settings: { rebootPolicy: 'disabled' },
          autoReplies: { welcome: { active: true } },
        },
      ],
      byName.wassenger_list_numbers.responseMapping,
    );
    expect(out.value).toEqual([
      {
        id: '61b37a069cba0c15d6c81000',
        phone: '+447911123456',
        alias: 'Support',
        connector: 'web',
        session: { status: 'online' },
        billing: { subscription: { plan: 'gateway-basic', status: 'active' } },
      },
    ]);
  });

  it('documents E.164, zero-based paging, plan limits and the QR-linked channel', () => {
    expect(a.instructions).toContain('+447911123456');
    expect(a.instructions).toMatch(/starting at 0/);
    expect(a.instructions).toMatch(/Platform plan/);
    expect(a.instructions).toMatch(/QR code/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1000);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
  });
});

// Opt-in: RUN_WASSENGER_LIVE=1 with WASSENGER_API_TOKEN of a (trial) account. Read-only.
const live = process.env.RUN_WASSENGER_LIVE === '1';
(live ? describe : describe.skip)('Wassenger: live read-only smoke test', () => {
  it('lists the numbers of the account', async () => {
    const token = process.env.WASSENGER_API_TOKEN;
    if (!token) throw new Error('Set WASSENGER_API_TOKEN for RUN_WASSENGER_LIVE=1');
    const response = await fetch('https://api.wassenger.com/v1/devices?size=5', { headers: { Token: token } });
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
