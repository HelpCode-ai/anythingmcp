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

  it('names the variable when its value has no https://, instead of the SSRF error', async () => {
    // An install from before the save-time check: the bare host went straight
    // into the base URL, and every call failed with "SSRF guard: invalid URL".
    const connector = {
      ...substack({ SUBSTACK_PUBLICATION_URL: 'yourname.substack.com' }),
      baseUrl: 'yourname.substack.com',
    };

    await expect(
      service.executeConnectorCall(
        connector,
        { method: 'GET', path: '/api/v1/posts' },
        {},
        'substack_list_posts',
      ),
    ).rejects.toThrow(
      /^SUBSTACK_PUBLICATION_URL must be a full URL such as https:\/\/yourname\.substack\.com, not "yourname\.substack\.com"\. The request from the connector behind substack_list_posts was not sent/,
    );
    expect(restEngine.execute).not.toHaveBeenCalled();
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

  // Run Test and the install probe used to skip the schema defaults the MCP
  // path fills in. A GAQL tool whose optional filter defaults to '%' then
  // sent `{}` and Google answered "unexpected end of query", while the same
  // call from Claude worked.
  describe('schema defaults', () => {
    const ads = () =>
      ({
        ...substack({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: '' }),
        baseUrl: 'https://googleads.googleapis.com/v25',
      }) as any;
    const mapping = {
      method: 'POST',
      path: '/customers/{customer_id}/googleAds:search',
      bodyMapping: {
        query: "SELECT campaign.name FROM campaign WHERE campaign.name LIKE '${campaign_name}' LIMIT ${limit}",
      },
    };
    const parameters = {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        campaign_name: { type: 'string', default: '%' },
        limit: { type: 'integer', default: 200 },
      },
    };
    const sent = () => restEngine.execute.mock.calls[0][2];

    it('fills in a default the caller left out, as a real MCP call does', async () => {
      await service.executeConnectorCall(ads(), mapping, { customer_id: '1' }, 'gads', parameters);
      expect(sent()).toMatchObject({ customer_id: '1', campaign_name: '%', limit: 200 });
    });

    it('keeps what the caller passed', async () => {
      await service.executeConnectorCall(
        ads(),
        mapping,
        { customer_id: '1', campaign_name: 'Brand%', limit: 5 },
        'gads',
        parameters,
      );
      expect(sent()).toMatchObject({ campaign_name: 'Brand%', limit: 5 });
    });

    it('lets a connector variable of the same name win over the schema default', async () => {
      const connector = { ...ads(), envVars: { limit: '50' } };
      await service.executeConnectorCall(connector, mapping, { customer_id: '1' }, 'gads', parameters);
      expect(sent()).toMatchObject({ limit: '50', campaign_name: '%' });
    });

    it('behaves as before without a schema', async () => {
      await service.executeConnectorCall(ads(), mapping, { customer_id: '1' }, 'gads');
      expect(sent()).not.toHaveProperty('campaign_name');
    });
  });
});
