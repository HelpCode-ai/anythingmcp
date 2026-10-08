import * as adapter from './gmail.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Static checks always run. The live block runs only with a Google access
 * token carrying gmail.readonly or gmail.modify (e.g. from the OAuth 2.0
 * Playground) and calls read-only tools through the real RestEngine; the
 * token goes out as the same Bearer header the OAUTH2 connector sends:
 *   GMAIL_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/gmail.live.spec.ts
 * Nothing is modified or sent. With GMAIL_LIVE_DRAFT=1 as well (and a
 * gmail.modify token) one draft addressed to the signed-in account is
 * created through gmail_create_draft, read back decoded and deleted again;
 * nothing is sent.
 */

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, any>;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  instructions: string;
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
  };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: Mapping;
    responseMapping?: Record<string, unknown>;
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('gmail adapter: static spec conformance', () => {
  it('is listed (verified live on 8 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('signs in with Google OAuth2 like the other Google adapters', () => {
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{GOOGLE_CLIENT_ID}}',
      clientSecret: '{{GOOGLE_CLIENT_SECRET}}',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/gmail.modify',
    });
    expect(a.requiredEnvVars).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
  });

  it('works on the signed-in mailbox and probes with the profile', () => {
    expect(a.connector.baseUrl).toBe('https://gmail.googleapis.com/gmail/v1/users/me');
    expect(a.connector.healthcheckPath).toBe('/profile');
    expect(a.probe.tool).toBe('gmail_get_profile');
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/')).toBe(true);
  });

  it('percent-encodes ids placed in the path', () => {
    for (const t of a.tools) {
      if (/\{\w+\}/.test(t.endpointMapping.path)) expect(`${t.name}:${t.endpointMapping.encodePathParams}`).toBe(`${t.name}:true`);
    }
  });

  it('writes only labels, drafts and sending; no DELETE, no trash', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`).sort()).toEqual([
      'POST /drafts',
      'POST /drafts/send',
      'POST /messages/send',
      'POST /messages/send',
      'POST /messages/{message_id}/modify',
      'POST /threads/{thread_id}/modify',
    ]);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/trash|delete/i);
  });

  it('composes messages with the __mime marker into the fields Gmail reads', () => {
    const fields = { to: '$to', cc: '$cc', bcc: '$bcc', subject: '$subject', text: '$body', html: '$html_body' };
    expect(tool('gmail_send_message').endpointMapping.bodyMapping).toEqual({ raw: { __mime: fields } });
    expect(tool('gmail_create_draft').endpointMapping.bodyMapping).toEqual({
      message: {
        raw: { __mime: { ...fields, inReplyTo: '$in_reply_to', references: '$references' } },
        threadId: '$thread_id',
      },
    });
    expect(tool('gmail_reply').endpointMapping.bodyMapping).toEqual({
      raw: {
        __mime: { ...fields, subjectPrefix: 'Re: ', inReplyTo: '$in_reply_to', references: '$references' },
      },
      threadId: '$thread_id',
    });
    expect(tool('gmail_send_message').parameters?.required).toEqual(['to', 'subject', 'body']);
    expect(tool('gmail_reply').parameters?.required).toEqual(['thread_id', 'in_reply_to', 'to', 'subject', 'body']);
  });

  it('decodes message bodies on the read tools and documents composing', () => {
    for (const name of ['gmail_get_message', 'gmail_get_thread', 'gmail_get_draft']) {
      expect(tool(name).responseMapping).toEqual({ decode: 'gmail-message' });
    }
    expect(a.instructions).not.toMatch(/does not compose/);
    expect(a.instructions).toContain('gmail_reply');
  });

  it('maps label arrays and the draft id to the API field names', () => {
    expect(tool('gmail_modify_message_labels').endpointMapping.bodyMapping).toEqual({
      addLabelIds: '$add_label_ids',
      removeLabelIds: '$remove_label_ids',
    });
    expect(tool('gmail_send_draft').endpointMapping.bodyMapping).toEqual({ id: '$draft_id' });
    expect(tool('gmail_list_messages').endpointMapping.queryParams?.labelIds).toBe('$label_ids');
  });
});

const TOKEN = process.env.GMAIL_ACCESS_TOKEN;
const live = TOKEN ? describe : describe.skip;

live('gmail adapter: live read-only calls', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
      },
      tool(name).endpointMapping,
      params,
    );
  const decode = (name: string, raw: unknown): any =>
    applyResponseTransform(raw, tool(name).responseMapping).value;

  it('reads the profile', async () => {
    const res = await run('gmail_get_profile');
    expect(res.emailAddress).toMatch(/@/);
  }, 30000);

  it('lists labels and reads the inbox label', async () => {
    const res = await run('gmail_list_labels');
    expect(res.labels.some((l: { id: string }) => l.id === 'INBOX')).toBe(true);
    const inbox = await run('gmail_get_label', { label_id: 'INBOX' });
    expect(typeof inbox.messagesTotal).toBe('number');
  }, 30000);

  it('searches messages with q and repeated labelIds, then reads one', async () => {
    const res = await run('gmail_list_messages', { q: 'newer_than:365d', label_ids: ['INBOX'], max_results: 2 });
    expect(typeof res.resultSizeEstimate).toBe('number');
    if (!res.messages?.length) return;
    const meta = await run('gmail_get_message', {
      message_id: res.messages[0].id,
      format: 'metadata',
      metadata_headers: ['From', 'Subject'],
    });
    expect(meta.labelIds).toContain('INBOX');
    const names = meta.payload.headers.map((h: { name: string }) => h.name);
    expect(names.every((n: string) => ['From', 'Subject'].includes(n))).toBe(true);
    const full = await run('gmail_get_message', { message_id: res.messages[0].id });
    expect(full.payload.mimeType).toBeTruthy();
    const decoded = decode('gmail_get_message', full);
    expect(decoded.id).toBe(res.messages[0].id);
    expect(decoded).not.toHaveProperty('payload');
    expect(typeof decoded.subject === 'string' || decoded.subject === undefined).toBe(true);
  }, 30000);

  it('lists threads and reads one', async () => {
    const res = await run('gmail_list_threads', { max_results: 1 });
    if (!res.threads?.length) return;
    const thread = await run('gmail_get_thread', { thread_id: res.threads[0].id, format: 'minimal' });
    expect(Array.isArray(thread.messages)).toBe(true);
  }, 30000);

  it('lists drafts', async () => {
    const res = await run('gmail_list_drafts', { max_results: 1 });
    expect(typeof res.resultSizeEstimate).toBe('number');
  }, 30000);

  (process.env.GMAIL_LIVE_DRAFT === '1' ? it : it.skip)(
    'creates a non-ASCII draft to the own address, reads it back decoded, deletes it',
    async () => {
      const me = (await run('gmail_get_profile')).emailAddress as string;
      const subject = 'AnythingMCP Test: Grüße, perché 👋 日本語';
      const body = 'Zeile 1: Straße\nRiga 2: città\n🚀';
      const created = await run('gmail_create_draft', { to: [`Jürgen Test <${me}>`], subject, body });
      expect(created.id).toBeTruthy();
      try {
        const draft = decode('gmail_get_draft', await run('gmail_get_draft', { draft_id: created.id }));
        expect(draft.message.subject).toBe(subject);
        expect(draft.message.to).toContain(me);
        expect(draft.message.text.replace(/\r\n/g, '\n').trim()).toBe(body);
      } finally {
        await engine.execute(
          { baseUrl: a.connector.baseUrl, authType: 'BEARER_TOKEN', authConfig: { token: TOKEN as string } },
          { method: 'DELETE', path: '/drafts/{id}', encodePathParams: true },
          { id: created.id },
        );
      }
    },
    30000,
  );
});
