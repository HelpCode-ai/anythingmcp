import * as adapter from './instagram.json';

type Tool = {
  name: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown> };
};
const a = adapter as unknown as {
  slug: string;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('instagram adapter: static spec conformance', () => {
  it('Graph API on graph.facebook.com, versioned', () =>
    expect(a.connector.baseUrl).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.0$/));

  it('Bearer auth with a ready (system user) token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{INSTAGRAM_ACCESS_TOKEN}}');
  });

  it('probe is a read with no required parameters', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
  });

  it('every tool is prefixed and every parameter reaches the request', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('instagram_')).toBe(true);
      const sent = JSON.stringify({ ...(t.endpointMapping.queryParams ?? {}), ...(t.endpointMapping.bodyMapping ?? {}) });
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        const reached = t.endpointMapping.path.includes(`{${p}}`) || sent.includes(`"$${p}"`) || sent.includes(`\${${p}}`);
        expect({ tool: t.name, param: p, reached }).toEqual({ tool: t.name, param: p, reached: true });
      }
    }
  });

  it('account-scoped tools take the account id from the connector', () => {
    expect(tool('instagram_list_media').endpointMapping.path).toBe('/{{INSTAGRAM_ACCOUNT_ID}}/media');
    expect(tool('instagram_get_account_insights').endpointMapping.path).toBe('/{{INSTAGRAM_ACCOUNT_ID}}/insights');
    expect(tool('instagram_search_hashtag').endpointMapping.queryParams).toMatchObject({ user_id: '{{INSTAGRAM_ACCOUNT_ID}}' });
  });

  it('publishing and deleting are installed switched off', () => {
    expect(tool('instagram_create_media_container').enabled).toBe(false);
    expect(tool('instagram_publish_media').enabled).toBe(false);
    expect(tool('instagram_delete_comment').enabled).toBe(false);
    expect(tool('instagram_delete_media').enabled).toBe(false);
    expect(tool('instagram_delete_comment').endpointMapping).toEqual({ method: 'DELETE', path: '/{comment_id}' });
  });

  it('reads an @mention through the field expansion on the account', () => {
    const media = tool('instagram_get_mentioned_media').endpointMapping;
    expect(media.path).toBe('/{{INSTAGRAM_ACCOUNT_ID}}');
    expect(media.queryParams).toEqual({ fields: 'mentioned_media.media_id(${media_id}){${fields}}' });
    const comment = tool('instagram_get_mentioned_comment').endpointMapping;
    expect(comment.queryParams).toEqual({ fields: 'mentioned_comment.comment_id(${comment_id}){${fields}}' });
    // The expansion needs a value for every placeholder: fields has a default.
    expect((tool('instagram_get_mentioned_media').parameters?.properties?.fields as { default?: string }).default).toBeTruthy();
    expect(tool('instagram_reply_to_mention').endpointMapping).toMatchObject({ method: 'POST', path: '/{{INSTAGRAM_ACCOUNT_ID}}/mentions' });
  });

  it('turns comments on or off with comment_enabled on the media', () => {
    expect(tool('instagram_set_comments_enabled').endpointMapping).toEqual({
      method: 'POST',
      path: '/{media_id}',
      queryParams: { comment_enabled: '$enabled' },
    });
  });

  it('lists the accounts a Unified Login token was given', () => {
    expect(tool('instagram_list_assigned_accounts').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/me/assigned_instagram_accounts',
    });
  });

  it('reads Direct Messages; sending is installed switched off', () => {
    expect(tool('instagram_list_conversations').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/{{INSTAGRAM_ACCOUNT_ID}}/conversations',
      queryParams: expect.objectContaining({ platform: 'instagram' }),
    });
    expect(tool('instagram_get_conversation_messages').endpointMapping.path).toBe('/{conversation_id}');
    for (const name of ['instagram_send_message', 'instagram_send_private_reply']) {
      expect(tool(name).enabled).toBe(false);
      expect(tool(name).endpointMapping).toMatchObject({ method: 'POST', path: '/{{INSTAGRAM_ACCOUNT_ID}}/messages' });
    }
  });

  it('can be authorized with Facebook: the app variables are the renewal ones', () => {
    const renewal = (a.connector.authConfig as unknown as { tokenRenewal: Record<string, string> }).tokenRenewal;
    expect(renewal).toMatchObject({ provider: 'meta', appIdVar: 'META_APP_ID', appSecretVar: 'META_APP_SECRET' });
  });
});

describe('instagram_get_media_insights metrics', () => {
  it('does not offer follows or profile_visits, which the media insights API rejects', () => {
    const t = tool('instagram_get_media_insights') as Tool & { description: string };
    expect(t.description).not.toMatch(/follows|profile_visits/);
    expect(t.parameters?.properties?.metric.description).not.toMatch(/follows|profile_visits/);
  });
});
