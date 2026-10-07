import * as adapter from './wanotifier.json';

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

describe('WANotifier adapter: static contract', () => {
  it('sends the API key as the key query parameter to the v1 API', () => {
    expect(a.requiredEnvVars).toEqual(['WANOTIFIER_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://app.wanotifier.com/api/v1');
    expect(a.connector.authType).toBe('QUERY_AUTH');
    expect(a.connector.authConfig).toEqual({ key: '{{WANOTIFIER_API_KEY}}' });
    expect(a.envVarMeta.WANOTIFIER_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.WANOTIFIER_API_KEY.pattern!).test('https://app.wanotifier.com/?key=x')).toBe(false);
    expect(a.probe.tool).toBe('wanotifier_list_contact_lists');
  });

  it('maps every tool to a documented endpoint', () => {
    const routes = a.tools.map((t) => `${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`);
    expect(routes).toEqual([
      'wanotifier_list_contact_lists GET /contacts/lists',
      'wanotifier_list_contact_tags GET /contacts/tags',
      'wanotifier_list_contacts GET /contacts',
      'wanotifier_get_contact GET /contacts/{contact_id}',
      'wanotifier_upsert_contact POST /contacts',
      'wanotifier_send_text_message POST /messages',
      'wanotifier_send_image_message POST /messages',
      'wanotifier_send_document_message POST /messages',
    ]);
    expect(a.tools.every((t) => t.name.startsWith('wanotifier_'))).toBe(true);
  });

  it('asks for more than WANotifier\'s default of one contact per page', () => {
    expect(byName.wanotifier_list_contacts.parameters.properties!.per_page.default).toBe(50);
  });

  it('builds the Cloud-API-shaped message body for each send', () => {
    const recipient = { whatsapp_number: '$whatsapp_number', contact_id: '$contact_id' };
    expect(byName.wanotifier_send_text_message.endpointMapping.bodyMapping).toEqual({
      recipient,
      message: { type: 'text', text: { body: '$body', preview_url: '$preview_url' } },
    });
    expect(byName.wanotifier_send_image_message.endpointMapping.bodyMapping).toEqual({
      recipient,
      message: { type: 'image', image: { link: '$link', caption: '$caption' } },
    });
    expect(byName.wanotifier_send_document_message.endpointMapping.bodyMapping).toEqual({
      recipient,
      message: { type: 'document', document: { link: '$link', filename: '$filename', caption: '$caption' } },
    });
    for (const t of a.tools.filter((x) => x.name.includes('_send_'))) {
      expect(t.description).toMatch(/confirm the recipient/);
    }
  });

  it('documents the E.164 format, the 24-hour window and the official API', () => {
    expect(a.instructions).toContain('+919876543210');
    expect(a.instructions).toMatch(/24-hour/);
    expect(a.instructions).toMatch(/official WhatsApp Business \(Cloud\) API/);
    expect(a.instructions.length).toBeGreaterThanOrEqual(1000);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
  });
});

// Opt-in: RUN_WANOTIFIER_LIVE=1 with WANOTIFIER_API_KEY of a (trial) account. Read-only.
const live = process.env.RUN_WANOTIFIER_LIVE === '1';
(live ? describe : describe.skip)('WANotifier: live read-only smoke test', () => {
  it.each(['/contacts/lists', '/contacts/tags'])('reads %s', async (path) => {
    const key = process.env.WANOTIFIER_API_KEY;
    if (!key) throw new Error('Set WANOTIFIER_API_KEY for RUN_WANOTIFIER_LIVE=1');
    const response = await fetch('https://app.wanotifier.com/api/v1' + path + '?key=' + encodeURIComponent(key));
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
