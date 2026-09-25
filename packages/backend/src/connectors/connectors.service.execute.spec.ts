import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * executeConnectorCall backs the in-app "Run Test" and the install probe. It
 * must resolve {{VAR}} and refuse leftovers the same way the MCP path does,
 * or the two disagree about the same connector.
 */
describe('ConnectorsService.executeConnectorCall placeholders', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const restEngine = { execute: jest.fn(), executeWithMeta: jest.fn() };
  const service = new ConnectorsService(
    {} as any,
    { get: () => KEY } as any,
    restEngine as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const substack = (envVars: Record<string, string> | null) =>
    ({
      id: 'c1',
      name: 'Substack',
      type: 'REST',
      baseUrl: '{{SUBSTACK_PUBLICATION_URL}}',
      authType: 'NONE',
      authConfig: null,
      headers: null,
      specUrl: null,
      envVars,
    }) as any;

  beforeEach(() => {
    restEngine.execute.mockReset().mockResolvedValue({ ok: true });
  });

  it('names the tool and the variable instead of sending the placeholder', async () => {
    await expect(
      service.executeConnectorCall(
        substack(null),
        { method: 'GET', path: '/api/v1/posts' },
        {},
        'substack_list_posts',
      ),
    ).rejects.toThrow(
      /^The connector behind substack_list_posts is missing a value for SUBSTACK_PUBLICATION_URL\./,
    );
    expect(restEngine.execute).not.toHaveBeenCalled();
  });

  it('uses a variable filled in after install', async () => {
    await service.executeConnectorCall(
      substack({ SUBSTACK_PUBLICATION_URL: 'https://example.substack.com' }),
      { method: 'GET', path: '/api/v1/posts' },
      {},
      'substack_list_posts',
    );

    expect(restEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://example.substack.com' }),
      expect.objectContaining({ path: '/api/v1/posts' }),
      expect.anything(),
    );
  });

  it('resolves credentials in authConfig at call time too', async () => {
    const connector = {
      ...substack({ TOKEN: 'secret-token' }),
      baseUrl: 'https://api.example.com',
      authType: 'BEARER_TOKEN',
      authConfig: encrypt(JSON.stringify({ token: '{{TOKEN}}' }), KEY),
    };

    await service.executeConnectorCall(connector, { method: 'GET', path: '/me' }, {});

    expect(restEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ authConfig: { token: 'secret-token' } }),
      expect.anything(),
      expect.anything(),
    );
  });
});
