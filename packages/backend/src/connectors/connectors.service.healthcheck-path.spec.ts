import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';
import { resolveHealthcheckPath } from './healthcheck-path.util';
import { getAdapter } from '../adapters/catalog';

/**
 * "Test connection" of a REST connector calls its healthcheckPath. The column
 * is copied from the catalog only at install and the catalog re-sync never
 * touches it, so Instagram connectors (whose adapter had no path) called the
 * bare Graph API base URL and Meta answered HTTP 400 "Unsupported get
 * request" (code 100) to every test, valid token or not.
 */
describe('ConnectorsService test connection path', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const row = {
    id: 'conn-ig',
    name: 'Instagram',
    type: 'REST',
    baseUrl: 'https://graph.facebook.com/v25.0',
    authType: 'BEARER_TOKEN',
    authConfig: encrypt(JSON.stringify({ token: 'test-token' }), KEY),
    headers: null,
    envVars: null,
    healthcheckPath: null as string | null,
    config: { adapterSlug: 'instagram' } as Record<string, unknown> | null,
    tools: [],
  };

  let prisma: any;
  let restEngine: any;
  let graphqlEngine: any;
  let service: ConnectorsService;

  function httpError(status: number, data: unknown) {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data },
    });
  }

  beforeEach(() => {
    prisma = {
      connector: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
    restEngine = { execute: jest.fn().mockResolvedValue({ ok: true }) };
    graphqlEngine = { execute: jest.fn().mockResolvedValue({ ok: true }) };
    service = new ConnectorsService(
      prisma,
      { get: () => KEY } as any,
      restEngine,
      {} as any,
      graphqlEngine,
      {} as any,
      {} as any,
    );
  });

  const sentPath = () => restEngine.execute.mock.calls[0][1].path;

  it('a catalog connector installed without a path uses its adapter\'s current one', async () => {
    const result = await service.testConnection('conn-ig');

    expect(sentPath()).toBe('/me?fields=id,name');
    expect(result).toEqual(expect.objectContaining({ ok: true, kind: 'ok' }));
  });

  it('the connector\'s own path wins over the catalog\'s', async () => {
    prisma.connector.findUnique.mockResolvedValue({ ...row, healthcheckPath: '/me/accounts' });

    await service.testConnection('conn-ig');

    expect(sentPath()).toBe('/me/accounts');
  });

  it('a connector with no path anywhere still calls the base URL', async () => {
    prisma.connector.findUnique.mockResolvedValue({ ...row, config: null });

    await service.testConnection('conn-ig');

    expect(sentPath()).toBe('/');
  });

  it.each([400, 404, 405])(
    'HTTP %i at the bare base URL is reported as a missing test path, not as an error',
    async (status) => {
      prisma.connector.findUnique.mockResolvedValue({ ...row, config: null });
      restEngine.execute.mockRejectedValue(
        httpError(status, { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100 } }),
      );

      const result = await service.testConnection('conn-ig');

      expect(result).toEqual(
        expect.objectContaining({ ok: false, kind: 'not_found', httpStatus: status }),
      );
      expect(result.message).toContain('base URL');
      expect(result.message).toContain('healthcheckPath');
    },
  );

  it('HTTP 400 at a configured path stays an error and names the path', async () => {
    restEngine.execute.mockRejectedValue(
      httpError(400, { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100 } }),
    );

    const result = await service.testConnection('conn-ig');

    expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'error', httpStatus: 400 }));
    expect(result.message).toContain('/me?fields=id,name');
  });

  it.each([190, 102, 10, 200, 299])(
    'Meta\'s HTTP 400 OAuthException code %i is a refused credential',
    async (code) => {
      restEngine.execute.mockRejectedValue(
        httpError(400, { error: { message: 'Error validating access token', type: 'OAuthException', code } }),
      );

      const result = await service.testConnection('conn-ig');

      expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'auth_failed', httpStatus: 400 }));
    },
  );

  it('reads an OAuthException body that arrives as a string', async () => {
    restEngine.execute.mockRejectedValue(
      httpError(400, JSON.stringify({ error: { type: 'OAuthException', code: 190 } })),
    );

    const result = await service.testConnection('conn-ig');

    expect(result.kind).toBe('auth_failed');
  });

  it('an OAuthException that is a plain request error (code 100) is not a refused credential', async () => {
    restEngine.execute.mockRejectedValue(
      httpError(400, { error: { message: 'Tried accessing nonexisting field', type: 'OAuthException', code: 100 } }),
    );

    const result = await service.testConnection('conn-ig');

    expect(result.kind).toBe('error');
  });

  // A GraphQL test POSTs { __typename } to the base URL and never reads
  // healthcheckPath, so its errors must not be reported as a missing test path.
  describe('GraphQL connector', () => {
    const gqlRow = {
      ...row,
      id: 'conn-gql',
      name: 'Some GraphQL API',
      type: 'GRAPHQL',
      baseUrl: 'https://api.example.com/graphql',
      config: null,
    };

    beforeEach(() => {
      prisma.connector.findUnique.mockResolvedValue(gqlRow);
    });

    it('HTTP 400 stays an error and does not tell the user to set healthcheckPath', async () => {
      graphqlEngine.execute.mockRejectedValue(
        httpError(400, { errors: [{ message: 'Missing or invalid token' }] }),
      );

      const result = await service.testConnection('conn-gql');

      expect(restEngine.execute).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'error', httpStatus: 400 }));
      expect(result.message).not.toContain('base URL');
      expect(result.message).not.toContain('credentials work');
    });

    it('HTTP 404 keeps the plain not-found wording', async () => {
      graphqlEngine.execute.mockRejectedValue(httpError(404, 'Not Found'));

      const result = await service.testConnection('conn-gql');

      expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'not_found', httpStatus: 404 }));
      expect(result.message).toContain('returned 404');
      expect(result.message).not.toContain('base URL');
    });
  });
});

describe('resolveHealthcheckPath', () => {
  it('ignores a blank path on the connector', () => {
    expect(
      resolveHealthcheckPath({ healthcheckPath: '  ', config: { adapterSlug: 'instagram' } }),
    ).toEqual({ path: '/me?fields=id,name', source: 'catalog' });
  });

  it('falls back to "/" for an unknown adapter slug', () => {
    expect(
      resolveHealthcheckPath({ healthcheckPath: null, config: { adapterSlug: 'no-such-adapter' } }),
    ).toEqual({ path: '/', source: 'default' });
  });

  it('every Meta Graph API adapter has a read-only test path', () => {
    const slugs = [
      'instagram',
      'instagram-login',
      'facebook-pages',
      'meta-ads',
      'meta-catalog',
      'threads',
      'whatsapp-business',
    ];
    for (const slug of slugs) {
      const path = (getAdapter(slug)?.connector as { healthcheckPath?: string } | undefined)
        ?.healthcheckPath;
      expect({ slug, ok: typeof path === 'string' && path.startsWith('/me') }).toEqual({
        slug,
        ok: true,
      });
    }
  });
});
