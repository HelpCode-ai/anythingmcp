import * as adapter from './substack.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { pickProbe } from '../probe.util';

type Tool = {
  name: string;
  parameters: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; encodePathParams?: boolean };
  responseMapping?: Record<string, unknown>;
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern: string; patternMessage: string }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { baseUrl: string; authType: string };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));
const urlPattern = new RegExp(a.envVarMeta.SUBSTACK_PUBLICATION_URL.pattern);

describe('substack adapter — static spec conformance', () => {
  it('per-publication base URL, public, no auth', () => {
    expect(a.requiredEnvVars).toEqual(['SUBSTACK_PUBLICATION_URL']);
    expect(a.connector.baseUrl).toBe('{{SUBSTACK_PUBLICATION_URL}}');
    expect(a.connector.authType).toBe('NONE');
  });

  it('keeps the five installed tool names and adds two read tools', () => {
    expect(a.tools.map((t) => t.name)).toEqual([
      'substack_list_posts',
      'substack_search_posts',
      'substack_get_post_by_id',
      'substack_get_post_by_slug',
      'substack_get_comments',
      'substack_get_rss_feed',
      'substack_find_publication_by_handle',
    ]);
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });

  it.each([
    'https://yourname.substack.com',
    'https://yourname.substack.com/',
    'https://www.lennysnewsletter.com',
    'https://newsletter.example.co.uk',
  ])('accepts the publication address %s', (value) => {
    expect(urlPattern.test(value)).toBe(true);
  });

  it.each([
    'https://substack.com/@lenny',
    'https://substack.com/@lenny/note/c-123456',
    'https://substack.com',
    'https://www.substack.com/',
    'https://open.substack.com',
    'https://yourname.substack.com/p/my-first-post',
    'https://yourname.substack.com/archive?sort=new',
    'yourname.substack.com',
    'http://yourname.substack.com',
    '@lenny',
  ])('refuses %s with a message that explains the home address', (value) => {
    expect(urlPattern.test(value)).toBe(false);
    expect(a.envVarMeta.SUBSTACK_PUBLICATION_URL.patternMessage).toMatch(/https:\/\/yourname\.substack\.com/);
  });

  it('lists posts through the archive endpoint, whose sort accepts new and top', () => {
    const list = byName.substack_list_posts;
    expect(list.endpointMapping.path).toBe('/api/v1/archive');
    expect(list.parameters.properties?.sort?.enum).toEqual(['new', 'top']);
    expect(byName.substack_get_comments.endpointMapping.path).toBe('/api/v1/post/{postId}/comments');
    expect(byName.substack_find_publication_by_handle.endpointMapping.path).toBe(
      'https://substack.com/api/v1/user/{handle}/public_profile',
    );
    expect(byName.substack_find_publication_by_handle.endpointMapping.encodePathParams).toBe(true);
  });

  it('probes with one post and explains a 404', () => {
    expect(pickProbe(a as never)).toEqual({ toolName: 'substack_list_posts', params: { limit: 1 } });
    expect(a.verifyHints['404']).toMatch(/not a profile/);
  });

  it('drops the heavy fields from list results and keeps the rest', () => {
    const sample = [{ id: 1, title: 'T', body_html: '<p>x</p>', publishedBylines: [{ name: 'N', publicationUsers: [{}] }] }];
    const out = applyResponseTransform(sample, byName.substack_list_posts.responseMapping as never);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual([{ id: 1, title: 'T', publishedBylines: [{ name: 'N' }] }]);
  });

  it('reduces a public profile to the publications a writer has', () => {
    const profile = {
      name: 'Writer',
      handle: 'writer',
      bio: 'b',
      subscriptions: [{ big: true }],
      primaryPublication: { name: 'Pub', subdomain: 'pub', custom_domain: 'www.pub.com', extra: 1 },
      publicationUsers: [{ role: 'admin', publication: { name: 'Pub', subdomain: 'pub', custom_domain: 'www.pub.com' } }],
    };
    const out = applyResponseTransform(profile, byName.substack_find_publication_by_handle.responseMapping as never);
    expect(out.value).toEqual({
      name: 'Writer',
      handle: 'writer',
      bio: 'b',
      primaryPublication: { name: 'Pub', subdomain: 'pub', custom_domain: 'www.pub.com' },
      publications: [{ name: 'Pub', subdomain: 'pub', custom_domain: 'www.pub.com', role: 'admin' }],
    });
  });
});

// Opt-in: RUN_SUBSTACK_LIVE=1 (optionally SUBSTACK_PUBLICATION_URL, SUBSTACK_HANDLE).
const live = process.env.RUN_SUBSTACK_LIVE === '1';
(live ? describe : describe.skip)('Substack — live read-only smoke test', () => {
  const base = (process.env.SUBSTACK_PUBLICATION_URL || 'https://www.lennysnewsletter.com').replace(/\/+$/, '');
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res;
  };

  it('lists, sorts, searches and opens posts', async () => {
    const newest = await (await get(`${base}/api/v1/archive?sort=new&limit=2`)).json();
    expect(Array.isArray(newest) && newest.length).toBe(2);
    const top = await (await get(`${base}/api/v1/archive?sort=top&limit=2`)).json();
    expect(Array.isArray(top)).toBe(true);
    const shaped = applyResponseTransform(newest, byName.substack_list_posts.responseMapping as never).value as Array<Record<string, unknown>>;
    expect(shaped[0].body_html).toBeUndefined();
    expect(typeof shaped[0].title).toBe('string');

    const found = await (await get(`${base}/api/v1/archive?sort=new&search=the&limit=1`)).json();
    expect(Array.isArray(found)).toBe(true);

    const byId = await (await get(`${base}/api/v1/posts/by-id/${newest[0].id}`)).json();
    expect(byId.post.id).toBe(newest[0].id);
    const bySlug = await (await get(`${base}/api/v1/posts/${encodeURIComponent(newest[0].slug)}`)).json();
    expect(bySlug.id).toBe(newest[0].id);
    const comments = await (await get(`${base}/api/v1/post/${newest[0].id}/comments?sort=most_recent_first`)).json();
    expect(Array.isArray(comments.comments)).toBe(true);
  });

  it('rejects a page larger than 50', async () => {
    const res = await fetch(`${base}/api/v1/archive?limit=51`);
    expect(res.status).toBe(400);
  });

  it('serves the RSS feed', async () => {
    const res = await get(`${base}/feed`);
    expect(await res.text()).toMatch(/<rss/);
  });

  it('resolves a handle to its publication', async () => {
    const handle = process.env.SUBSTACK_HANDLE || 'lenny';
    const profile = await (await get(`https://substack.com/api/v1/user/${handle}/public_profile`)).json();
    const shaped = applyResponseTransform(profile, byName.substack_find_publication_by_handle.responseMapping as never)
      .value as { publications: Array<{ subdomain: string }> };
    expect(shaped.publications.length).toBeGreaterThan(0);
    expect(typeof shaped.publications[0].subdomain).toBe('string');
  });
});
