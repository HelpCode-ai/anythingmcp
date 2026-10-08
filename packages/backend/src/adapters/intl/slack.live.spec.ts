import * as adapter from './slack.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import {
  assertNoResponseBodyError,
  describeErrorWhenProblems,
  ResponseBodyError,
} from '../../connectors/engines/response-error.util';

/**
 * Static checks always run. The live block runs only with a real token and
 * calls read-only methods through the real RestEngine:
 *   SLACK_TOKEN=xoxb-... npx jest src/adapters/intl/slack.live.spec.ts
 * SLACK_TEST_CHANNEL=C0123 also reads that channel's history (the app must be
 * a member). Nothing is posted.
 */

type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, string>;
  bodyMapping?: Record<string, unknown>;
  bodyEncoding?: string;
};
const a = adapter as unknown as {
  unlisted?: boolean;
  requiredEnvVars: string[];
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    headers: Record<string, string>;
    healthcheckPath: string;
    config: { errorWhen: unknown };
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
const rules = a.connector.config.errorWhen;
const statusOf = (body: unknown): number | null => {
  try {
    assertNoResponseBodyError(body, rules);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ResponseBodyError);
    return (e as ResponseBodyError).status;
  }
};

describe('slack adapter: static spec conformance', () => {
  it('is listed (verified live on 8 Oct 2026)', () => {
    expect(a.unlisted).toBeUndefined();
  });

  it('sends the pasted token as a Bearer header with a User-Agent', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{SLACK_TOKEN}}' });
    expect(a.requiredEnvVars).toEqual(['SLACK_TOKEN']);
    expect(a.connector.headers['User-Agent']).toBe('AnythingMCP');
  });

  it('probes with auth.test', () => {
    expect(a.connector.baseUrl).toBe('https://slack.com/api');
    expect(a.connector.healthcheckPath).toBe('/auth.test');
    expect(a.probe.tool).toBe('slack_auth_test');
    expect(tool('slack_auth_test').endpointMapping).toEqual({ method: 'GET', path: '/auth.test' });
  });

  it('reads with GET and writes with form-encoded POST, never DELETE', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      expect(m.path).toMatch(/^\/[a-z]+\.[a-zA-Z]+$/);
      if (m.method === 'POST') expect(`${t.name}:${m.bodyEncoding}`).toBe(`${t.name}:form-urlencoded`);
      else expect(m.method).toBe('GET');
    }
    expect(a.tools.filter((t) => t.endpointMapping.method === 'POST').map((t) => t.name).sort()).toEqual([
      'slack_add_reaction',
      'slack_join_channel',
      'slack_post_message',
    ]);
  });

  it('installs search switched off: it needs a user token', () => {
    expect(tool('slack_search_messages').enabled).toBe(false);
    for (const t of a.tools.filter((x) => x.name !== 'slack_search_messages')) expect(t.enabled).toBeUndefined();
  });

  it('has well-formed errorWhen rules', () => {
    expect(describeErrorWhenProblems(rules)).toEqual([]);
  });

  it('turns ok:false bodies into errors with a fitting status', () => {
    expect(statusOf({ ok: true, channels: [] })).toBeNull();
    expect(statusOf({ ok: true, warning: 'missing_charset' })).toBeNull();
    expect(statusOf({ ok: false, error: 'invalid_auth' })).toBe(401);
    expect(statusOf({ ok: false, error: 'token_revoked' })).toBe(401);
    expect(statusOf({ ok: false, error: 'missing_scope', needed: 'chat:write', provided: 'users:read' })).toBe(403);
    expect(statusOf({ ok: false, error: 'not_allowed_token_type' })).toBe(403);
    expect(statusOf({ ok: false, error: 'not_in_channel' })).toBe(403);
    expect(statusOf({ ok: false, error: 'ratelimited' })).toBe(429);
    expect(statusOf({ ok: false, error: 'channel_not_found' })).toBe(404);
    expect(statusOf({ ok: false, error: 'already_reacted' })).toBe(400);
    expect(statusOf({ ok: false, error: 'msg_too_long' })).toBe(400);
  });

  it('names the missing scope in the error message', () => {
    expect(() =>
      assertNoResponseBodyError({ ok: false, error: 'missing_scope', needed: 'chat:write' }, rules),
    ).toThrow(/missing_scope chat:write/);
  });
});

const TOKEN = process.env.SLACK_TOKEN;
const CHANNEL = process.env.SLACK_TEST_CHANNEL;
const live = TOKEN ? describe : describe.skip;

live('slack adapter: live read-only calls', () => {
  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  const run = (name: string, params: Record<string, unknown> = {}): Promise<any> =>
    engine.execute(
      {
        baseUrl: a.connector.baseUrl,
        authType: 'BEARER_TOKEN',
        authConfig: { token: TOKEN as string },
        headers: a.connector.headers,
        errorWhen: rules,
      },
      tool(name).endpointMapping,
      params,
    );

  it('auth.test answers ok', async () => {
    const res = await run('slack_auth_test');
    expect(res.ok).toBe(true);
    expect(res.team_id).toBeTruthy();
  }, 30000);

  it('lists conversations and gets one', async () => {
    const res = await run('slack_list_conversations', { limit: 5, exclude_archived: true });
    expect(Array.isArray(res.channels)).toBe(true);
    if (res.channels.length) {
      const info = await run('slack_get_conversation_info', { channel: res.channels[0].id, include_num_members: true });
      expect(info.channel.id).toBe(res.channels[0].id);
    }
  }, 30000);

  it('lists users and gets one', async () => {
    const res = await run('slack_list_users', { limit: 5 });
    expect(Array.isArray(res.members)).toBe(true);
    const info = await run('slack_get_user_info', { user: res.members[0].id });
    expect(info.user.id).toBe(res.members[0].id);
  }, 30000);

  (CHANNEL ? it : it.skip)('reads channel history', async () => {
    const res = await run('slack_get_conversation_history', { channel: CHANNEL, limit: 3 });
    expect(Array.isArray(res.messages)).toBe(true);
  }, 30000);

  it('an unknown channel surfaces as an error, not a 200 body', async () => {
    await expect(run('slack_get_conversation_info', { channel: 'C00000000' })).rejects.toBeInstanceOf(ResponseBodyError);
  }, 30000);
});
