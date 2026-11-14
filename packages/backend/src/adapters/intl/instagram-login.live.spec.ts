/**
 * Instagram API with Instagram Login (graph.instagram.com).
 *
 * Static assertions always run. The live calls need a long-lived Instagram
 * User token of a professional account and run only when asked for:
 *
 *   RUN_INSTAGRAM_LOGIN_LIVE=1 INSTAGRAM_ACCESS_TOKEN=IG... npx jest instagram-login.live
 *
 * They only read (profile, media, publishing limit); nothing is posted.
 */
import axios from 'axios';
import * as adapter from './instagram-login.json';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  annotations?: Record<string, boolean>;
  parameters?: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
  };
};
const a = adapter as unknown as {
  slug: string;
  icon: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('instagram-login adapter: static spec conformance', () => {
  it('calls graph.instagram.com, versioned', () => {
    expect(a.slug).toBe('instagram-login');
    expect(a.connector.baseUrl).toMatch(/^https:\/\/graph\.instagram\.com\/v\d+\.0$/);
    expect(a.icon).toBe('instagram');
  });

  it('takes a bearer token that the engine refreshes with ig_refresh_token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{INSTAGRAM_ACCESS_TOKEN}}');
    expect(a.connector.authConfig.tokenRenewal).toMatchObject({ provider: 'instagram_login' });
    expect(a.requiredEnvVars).toEqual(['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID']);
    expect(a.optionalEnvVars).toEqual(['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET']);
  });

  it('probe is a read with no required parameters', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
  });

  it('every tool is prefixed and every parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('instagram_login_')).toBe(true);
      const sent = JSON.stringify({ ...(t.endpointMapping.queryParams ?? {}), ...(t.endpointMapping.bodyMapping ?? {}) });
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        const reached = t.endpointMapping.path.includes(`{${p}}`) || sent.includes(`"$${p}"`) || sent.includes(`\${${p}}`);
        expect({ tool: t.name, param: p, reached }).toEqual({ tool: t.name, param: p, reached: true });
      }
    }
  });

  it('account-scoped tools take the account id from the connector', () => {
    for (const name of [
      'instagram_login_list_media',
      'instagram_login_get_account_insights',
      'instagram_login_list_conversations',
      'instagram_login_send_message',
      'instagram_login_create_media_container',
      'instagram_login_publish_media',
    ]) {
      expect(tool(name).endpointMapping.path.startsWith('/{{INSTAGRAM_ACCOUNT_ID}}/')).toBe(true);
    }
  });

  it('lists Instagram conversations only', () => {
    expect(tool('instagram_login_list_conversations').endpointMapping.queryParams).toMatchObject({ platform: 'instagram' });
  });

  it('sends a message as a JSON body with a recipient and the text', () => {
    expect(tool('instagram_login_send_message').endpointMapping.bodyMapping).toEqual({
      recipient: { id: '$recipient_id' },
      message: { text: '$text' },
    });
    expect(tool('instagram_login_send_private_reply').endpointMapping.bodyMapping).toEqual({
      recipient: { comment_id: '$comment_id' },
      message: { text: '$text' },
    });
  });

  it('installs sending, publishing and deleting switched off', () => {
    for (const name of [
      'instagram_login_send_message',
      'instagram_login_send_private_reply',
      'instagram_login_create_media_container',
      'instagram_login_publish_media',
      'instagram_login_delete_comment',
    ]) {
      expect({ name, enabled: tool(name).enabled }).toEqual({ name, enabled: false });
    }
    expect(tool('instagram_login_delete_comment').annotations).toEqual({ destructiveHint: true });
    expect(tool('instagram_login_publish_media').annotations).toEqual({ destructiveHint: true });
    // Reading stays on.
    expect(tool('instagram_login_list_conversations').enabled).toBeUndefined();
  });

  it('has no hashtag or business discovery tool, which Instagram Login does not offer', () => {
    expect(a.tools.some((t) => /hashtag|business_discovery|discover/.test(t.name))).toBe(false);
    expect(a.instructions).toMatch(/Facebook Login only|exist only in the Instagram API with Facebook Login/);
  });

  it('documents the sign-in and the redirect URI to register', () => {
    expect(a.instructions).toMatch(/Authorize with Instagram/);
    expect(a.instructions).toMatch(/\/api\/meta\/callback/);
  });
});

const live = process.env.RUN_INSTAGRAM_LOGIN_LIVE === '1' && !!process.env.INSTAGRAM_ACCESS_TOKEN;
(live ? describe : describe.skip)('instagram-login adapter: live', () => {
  const http = axios.create({
    baseURL: a.connector.baseUrl,
    headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
    timeout: 20_000,
  });
  let accountId = process.env.INSTAGRAM_ACCOUNT_ID ?? '';

  it('reads the account', async () => {
    const res = await http.get('/me', { params: { fields: tool('instagram_login_get_account').parameters?.properties?.fields?.default } });
    expect(res.data.username).toEqual(expect.any(String));
    accountId = accountId || String(res.data.user_id);
    expect(accountId).toMatch(/^\d+$/);
  });

  it('lists media', async () => {
    const res = await http.get(`/${accountId}/media`, { params: { fields: 'id,media_type,timestamp', limit: 3 } });
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('reads the publishing limit', async () => {
    const res = await http.get(`/${accountId}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } });
    expect(Array.isArray(res.data.data)).toBe(true);
  });
});
