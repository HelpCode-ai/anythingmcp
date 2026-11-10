import * as adapter from './ghost.json';
import { signHmacJwt } from '../../connectors/engines/hmac-jwt.util';

const a = adapter as unknown as {
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string }>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { signature: Record<string, any> } };
  tools: Array<{ name: string }>;
};

describe('ghost adapter — static spec conformance', () => {
  it('per-site base URL', () => expect(a.connector.baseUrl).toBe('{{GHOST_ADMIN_API_URL}}'));

  it('signs a Ghost Admin JWT per request from the Admin API key (no hand-made JWT)', () => {
    expect(a.connector.authType).toBe('HMAC');
    const sig = a.connector.authConfig.signature;
    expect(sig.headerName).toBe('Authorization');
    expect(sig.headerTemplate).toBe('Ghost ${jwt}');
    expect(sig.jwt).toMatchObject({
      key: '{{GHOST_ADMIN_API_KEY}}',
      keyFormat: 'id:secret',
      secretEncoding: 'hex',
      algorithm: 'HS256',
      claims: { aud: '/admin/' },
    });
    // Ghost refuses tokens that live longer than 5 minutes.
    expect(sig.jwt.ttlSeconds).toBeLessThanOrEqual(300);
    expect(a.requiredEnvVars).toEqual(['GHOST_ADMIN_API_URL', 'GHOST_ADMIN_API_KEY']);
    expect(JSON.stringify(adapter)).not.toContain('GHOST_ADMIN_JWT');
  });

  it('the key pattern takes an Admin API key and refuses a Content API key', () => {
    const pattern = new RegExp(a.envVarMeta.GHOST_ADMIN_API_KEY.pattern!);
    expect(pattern.test(`${'a'.repeat(24)}:${'b'.repeat(64)}`)).toBe(true);
    expect(pattern.test('a1b2c3d4e5f6a7b8c9d0e1f2a3')).toBe(false);
  });

  it('the URL pattern wants the /ghost/api/admin path', () => {
    const pattern = new RegExp(a.envVarMeta.GHOST_ADMIN_API_URL.pattern!);
    expect(pattern.test('https://yoursite.ghost.io/ghost/api/admin')).toBe(true);
    expect(pattern.test('https://yoursite.ghost.io')).toBe(false);
  });

  it('the setup check calls an endpoint that needs the token', () => {
    // /site/ answers without authentication, so it would pass any key.
    expect(a.probe.tool).toBe('ghost_list_posts');
    expect(a.tools.some((t) => t.name === a.probe.tool)).toBe(true);
  });
});

/**
 * Live check against a real Ghost site, only with RUN_GHOST_LIVE=1 and
 * GHOST_ADMIN_API_URL + GHOST_ADMIN_API_KEY set. Read-only.
 */
const live = process.env.RUN_GHOST_LIVE === '1' ? describe : describe.skip;
live('ghost adapter — live', () => {
  it('lists one post with a token signed from the Admin API key', async () => {
    const base = String(process.env.GHOST_ADMIN_API_URL).replace(/\/$/, '');
    const jwtCfg = JSON.parse(
      JSON.stringify(a.connector.authConfig.signature.jwt).replace(
        '{{GHOST_ADMIN_API_KEY}}',
        String(process.env.GHOST_ADMIN_API_KEY),
      ),
    );
    const res = await fetch(`${base}/posts/?limit=1&fields=id`, {
      headers: { Authorization: `Ghost ${signHmacJwt(jwtCfg)}`, 'Accept-Version': 'v5.0' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: unknown[] };
    expect(Array.isArray(body.posts)).toBe(true);
  });
});
