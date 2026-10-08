import * as adapter from './gmail.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';

/**
 * Static checks always run. The live block runs only with a Google access
 * token carrying gmail.readonly or gmail.modify (e.g. from the OAuth 2.0
 * Playground) and calls read-only tools through the real RestEngine; the
 * token goes out as the same Bearer header the OAUTH2 connector sends:
 *   GMAIL_ACCESS_TOKEN=ya29... npx jest src/adapters/intl/gmail.live.spec.ts
 * Nothing is modified or sent.
 */

type Mapping = {
  method: string;
  path: string;
  encodePathParams?: boolean;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
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
  }>;
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('gmail adapter: static spec conformance', () => {
  it('stays unlisted until tested against a real mailbox', () => {
    expect(a.unlisted).toBe(true);
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

  it('writes only label changes and sending an existing draft; no DELETE, no trash', () => {
    const writes = a.tools.filter((t) => t.endpointMapping.method !== 'GET');
    expect(writes.map((t) => `${t.endpointMapping.method} ${t.endpointMapping.path}`).sort()).toEqual([
      'POST /drafts/send',
      'POST /messages/{message_id}/modify',
      'POST /threads/{thread_id}/modify',
    ]);
    for (const t of a.tools) expect(t.endpointMapping.path).not.toMatch(/trash|delete/i);
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
});
