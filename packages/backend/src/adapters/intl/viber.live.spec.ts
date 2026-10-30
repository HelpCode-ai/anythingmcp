import * as adapter from './viber.json';

/**
 * Viber REST Bot API (developers.viber.com/docs/api/rest-bot-api): base
 * https://chatapi.viber.com/pa, every call a JSON POST with the bot token in
 * the X-Viber-Auth-Token header; answers are HTTP 200 with status 0 on success
 * and a non-zero status (plus status_message) on failure.
 * Live part (read only: the bot account):
 *   VIBER_AUTH_TOKEN=... RUN_VIBER_LIVE=1 npx jest src/adapters/intl/viber
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
};
type ErrorRule = { path: string; in?: unknown[]; equals?: unknown; messagePath?: string; status?: number };
const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; example?: string }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string>; config?: { errorWhen?: ErrorRule[] } };
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
  for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) out.add(p);
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
const SENDS: Record<string, string> = {
  viber_send_text: 'text',
  viber_send_picture: 'picture',
  viber_send_video: 'video',
  viber_send_file: 'file',
  viber_send_url: 'url',
  viber_send_contact: 'contact',
  viber_send_location: 'location',
  viber_send_sticker: 'sticker',
  viber_send_rich_media: 'rich_media',
};
const READS = ['viber_get_account_info', 'viber_get_user_details', 'viber_get_online'];

describe('viber adapter: static spec conformance', () => {
  it('sends the bot token in X-Viber-Auth-Token to chatapi.viber.com/pa', () => {
    expect(a.requiredEnvVars).toEqual(['VIBER_AUTH_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://chatapi.viber.com/pa');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-Viber-Auth-Token', apiKey: '{{VIBER_AUTH_TOKEN}}' });
    expect(a.envVarMeta?.VIBER_AUTH_TOKEN.secret).toBe(true);
    // The documented sample token matches the pattern.
    expect(new RegExp(a.envVarMeta?.VIBER_AUTH_TOKEN.pattern ?? '').test(a.envVarMeta?.VIBER_AUTH_TOKEN.example ?? '')).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping.method).toBe('POST');
  });

  it('turns a non-zero status in the 200 body into an error, auth codes as 401', () => {
    const rules = a.connector.config?.errorWhen ?? [];
    expect(rules[0]).toEqual({ path: 'status', in: [2, 7, 8, 9, 15], messagePath: 'status_message', status: 401 });
    expect(rules[1]).toMatchObject({ path: 'status', equals: 12, status: 429 });
    // Last rule: any status that is present and not 0.
    expect(rules[rules.length - 1]).toEqual({ path: 'status', messagePath: 'status_message', status: 400 });
  });

  it('maps the read calls', () => {
    expect(tool('viber_get_account_info').endpointMapping).toEqual({ method: 'POST', path: '/get_account_info', bodyMapping: {} });
    expect(tool('viber_get_user_details').endpointMapping).toEqual({ method: 'POST', path: '/get_user_details', bodyMapping: { id: '$id' } });
    expect(tool('viber_get_online').endpointMapping).toEqual({ method: 'POST', path: '/get_online', bodyMapping: { ids: '$ids' } });
    for (const n of READS) expect(tool(n).annotations).toEqual({ readOnlyHint: true });
  });

  it('every send tool posts to /send_message with its fixed type, the receiver and a sender', () => {
    for (const [n, type] of Object.entries(SENDS)) {
      const m = tool(n).endpointMapping;
      expect(m.path).toBe('/send_message');
      expect(m.bodyMapping).toMatchObject({ receiver: '$receiver', type, sender: { name: '$sender_name', avatar: '$sender_avatar' }, keyboard: '$keyboard', tracking_data: '$tracking_data', min_api_version: '$min_api_version' });
      expect(tool(n).parameters?.required).toEqual(expect.arrayContaining(['receiver', 'sender_name']));
    }
    expect(tool('viber_send_text').endpointMapping.bodyMapping).toMatchObject({ text: '$text' });
    expect(tool('viber_send_picture').endpointMapping.bodyMapping).toMatchObject({ media: '$media', text: '$text', thumbnail: '$thumbnail' });
    expect(tool('viber_send_video').endpointMapping.bodyMapping).toMatchObject({ media: '$media', size: '$size', duration: '$duration' });
    expect(tool('viber_send_file').endpointMapping.bodyMapping).toMatchObject({ media: '$media', size: '$size', file_name: '$file_name' });
    expect(tool('viber_send_contact').endpointMapping.bodyMapping).toMatchObject({ contact: { name: '$contact_name', phone_number: '$contact_phone_number' } });
    expect(tool('viber_send_location').endpointMapping.bodyMapping).toMatchObject({ location: { lat: '$lat', lon: '$lon' } });
    expect(tool('viber_send_sticker').endpointMapping.bodyMapping).toMatchObject({ sticker_id: '$sticker_id' });
    expect(tool('viber_send_rich_media').endpointMapping.bodyMapping).toMatchObject({ rich_media: '$rich_media', alt_text: '$alt_text' });
  });

  it('broadcasts to at most 300 receivers and manages the webhook through set_webhook', () => {
    const b = tool('viber_broadcast_message');
    expect(b.endpointMapping).toMatchObject({ path: '/broadcast_message', bodyMapping: { broadcast_list: '$broadcast_list', type: '$type' } });
    expect((b.parameters?.properties?.broadcast_list as { maxItems?: number }).maxItems).toBe(300);
    expect(b.parameters?.properties?.type.enum).toEqual(Object.values(SENDS));
    expect(tool('viber_set_webhook').endpointMapping).toEqual({
      method: 'POST',
      path: '/set_webhook',
      bodyMapping: { url: '$url', event_types: '$event_types', send_name: '$send_name', send_photo: '$send_photo' },
    });
    expect(tool('viber_set_webhook').parameters?.properties?.event_types.items?.enum).toEqual(['delivered', 'seen', 'failed', 'subscribed', 'unsubscribed', 'conversation_started', 'message']);
    // Removing is set_webhook with an empty URL, a literal the engine keeps.
    expect(tool('viber_remove_webhook').endpointMapping).toEqual({ method: 'POST', path: '/set_webhook', bodyMapping: { url: '' } });
    for (const n of ['viber_set_webhook', 'viber_remove_webhook']) expect(tool(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('every tool is prefixed and every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('viber_')).toBe(true);
      expect(t.enabled).toBeUndefined();
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
    }
  });

  it('probes with the account info and documents every tool, the commercial terms and the subscription rule', () => {
    expect(a.probe.tool).toBe('viber_get_account_info');
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(a.instructions).toMatch(/commercial terms/);
    expect(a.instructions).toMatch(/\*\*subscribed\*\*/);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_VIBER_LIVE === '1' && process.env.VIBER_AUTH_TOKEN ? describe : describe.skip;
live('viber adapter: live (read-only)', () => {
  it('reads the bot account', async () => {
    const res = await fetch(`${a.connector.baseUrl}/get_account_info`, {
      method: 'POST',
      headers: { 'X-Viber-Auth-Token': String(process.env.VIBER_AUTH_TOKEN), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: number; status_message: string; id?: string; name?: string };
    expect(`${body.status} ${body.status_message}`).toBe('0 ok');
    expect(typeof body.name).toBe('string');
  }, 30_000);
});
