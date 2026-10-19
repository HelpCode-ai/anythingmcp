import * as adapter from './line-messaging.json';

/**
 * Static checks for the LINE Messaging API adapter. The Cloud log of one
 * connector (8 Oct 2026) showed every error was a value the model made up:
 * a placeholder replyToken ("REPLACE_WITH_REAL_TOKEN", "dummy"), userId
 * "dummy", a message without `type`, an empty `messages` array. The tools now
 * describe the message object (type required, 1 to 5 per call), say where a
 * real userId and replyToken come from, and add read tools for the bot, the
 * monthly quota and the follower ids. The read tools were run against a live
 * channel on 19 Oct 2026: bot info and both quota calls answered 200, the
 * follower ids 403 on an unverified account, as LINE documents.
 */
type Prop = { type?: string; items?: { required?: string[]; properties?: Record<string, unknown> }; minItems?: number; maxItems?: number; description?: string };
type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, Prop>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string> };
};
const a = adapter as unknown as {
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe('line-messaging adapter: static spec conformance', () => {
  it('channel access token as Bearer against api.line.me', () => {
    expect(a.connector.baseUrl).toBe('https://api.line.me');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{LINE_CHANNEL_ACCESS_TOKEN}}');
  });

  it.each(['line_push_message', 'line_reply_message', 'line_broadcast_message'])(
    '%s: 1 to 5 message objects, each with a type',
    (name) => {
      const messages = tool(name).parameters.properties!.messages;
      expect(messages.type).toBe('array');
      expect(messages.minItems).toBe(1);
      expect(messages.maxItems).toBe(5);
      expect(messages.items?.required).toEqual(['type']);
    },
  );

  it('reply and profile say not to invent tokens or userIds', () => {
    expect(tool('line_reply_message').parameters.properties!.replyToken.description).toMatch(/not invent/i);
    expect(tool('line_get_profile').parameters.properties!.userId.description).toMatch(/U followed by 32 hex/);
    expect(a.instructions).toMatch(/placeholder/);
  });

  it.each([
    ['line_get_bot_info', '/v2/bot/info'],
    ['line_get_message_quota', '/v2/bot/message/quota'],
    ['line_get_message_quota_consumption', '/v2/bot/message/quota/consumption'],
    ['line_list_follower_ids', '/v2/bot/followers/ids'],
    ['line_get_profile', '/v2/bot/profile/{userId}'],
  ])('%s is a GET on %s', (name, path) => {
    expect(tool(name).endpointMapping).toMatchObject({ method: 'GET', path });
  });

  it('follower ids page with limit and start', () => {
    expect(tool('line_list_follower_ids').endpointMapping.queryParams).toEqual({ limit: '$limit', start: '$start' });
  });

  it('no hard-coded free quota: it differs by country', () => {
    expect(JSON.stringify(a)).not.toMatch(/500\/month|500 push/);
  });
});
