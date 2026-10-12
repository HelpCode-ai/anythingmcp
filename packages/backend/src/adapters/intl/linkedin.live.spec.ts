import * as adapter from './linkedin.json';

type Tool = {
  name: string;
  parameters: { properties: Record<string, { default?: unknown; enum?: string[] }> };
  endpointMapping: {
    method: string;
    path: string;
    encodePathParams?: boolean;
    headers?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
    exposeHeaders?: string[];
  };
};
const a = adapter as unknown as {
  instructions: string;
  connector: { baseUrl: string; authType: string };
  tools: Tool[];
};
const tool = (name: string) => a.tools.find((t) => t.name === name)!;
const versioned = a.tools.filter((t) => t.name !== 'linkedin_userinfo');

describe('linkedin adapter: static spec conformance (checked against the 202609 docs, 12 Oct 2026)', () => {
  it('api.linkedin.com/v2 base for the OpenID Connect userinfo endpoint', () => {
    expect(a.connector.baseUrl).toBe('https://api.linkedin.com/v2');
    expect(tool('linkedin_userinfo').endpointMapping).toEqual({ method: 'GET', path: '/userinfo' });
  });

  it('a pasted member token, sent as Bearer (no OAuth flow, so no PKCE setting)', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
  });

  it('posts and images call the versioned /rest API with a supported LinkedIn-Version and Rest.li 2.0', () => {
    expect(versioned).toHaveLength(4);
    for (const t of versioned) {
      expect(t.endpointMapping.path.startsWith('https://api.linkedin.com/rest/')).toBe(true);
      // 202405 was retired: LinkedIn answers 426 to versions past their sunset.
      expect(t.endpointMapping.headers?.['LinkedIn-Version']).toBe('202609');
      expect(t.endpointMapping.headers?.['X-Restli-Protocol-Version']).toBe('2.0.0');
    }
  });

  it('no tool or instruction still names the retired version', () => {
    expect(JSON.stringify(adapter)).not.toContain('202405');
  });

  it('create_post sends every field LinkedIn requires, and returns the new URN header', () => {
    const t = tool('linkedin_create_post');
    expect(t.endpointMapping.bodyMapping).toMatchObject({
      author: '$author',
      commentary: '$commentary',
      visibility: '$visibility',
      distribution: '$distribution',
      // PUBLISHED is the only state accepted on creation.
      lifecycleState: 'PUBLISHED',
    });
    expect(t.parameters.properties.visibility.default).toBe('PUBLIC');
    expect(t.parameters.properties.distribution.default).toEqual({
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    });
    expect(t.endpointMapping.exposeHeaders).toEqual(['x-restli-id']);
  });

  it('post URNs are taken raw and encoded into the path', () => {
    for (const name of ['linkedin_get_post', 'linkedin_delete_post']) {
      expect(tool(name).endpointMapping).toMatchObject({
        path: 'https://api.linkedin.com/rest/posts/{postUrn}',
        encodePathParams: true,
      });
    }
  });

  it('instructions keep the honest gating notes and use no em dashes', () => {
    expect(a.instructions).toContain('r_member_social');
    expect(a.instructions).toContain('w_member_social');
    expect(a.instructions).not.toContain('—');
  });
});
