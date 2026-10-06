import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * Test connection runs on every dashboard load (health-check) and refreshes
 * OAuth2 tokens like a tool call does. Before this, it did so without the
 * connector's id, so the refreshed tokens were never saved: a provider that
 * rotates refresh tokens (JTL, Sage, DATEV) revoked the one the connector
 * kept, and its next refresh failed with "Token has been revoked".
 */
describe('ConnectorsService OAuth2 token bookkeeping', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const authConfig = {
    clientId: 'cid',
    clientSecret: 'secret',
    tokenUrl: 'https://oauth2.example.com/token',
    refreshToken: 'rt-1',
    accessToken: 'at-1',
  };
  const row = {
    id: 'conn-ffn',
    name: 'FFN Connect',
    type: 'REST',
    baseUrl: 'https://api.example.com',
    authType: 'OAUTH2',
    authConfig: encrypt(JSON.stringify(authConfig), KEY),
    headers: null,
    envVars: null,
    healthcheckPath: '/merchant/info',
    tools: [],
  };

  let prisma: any;
  let restEngine: any;
  let graphqlEngine: any;
  let mcpClientEngine: any;
  let tokens: any;
  let service: ConnectorsService;

  beforeEach(() => {
    prisma = {
      connector: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
    restEngine = { execute: jest.fn().mockResolvedValue({ ok: true }) };
    graphqlEngine = { execute: jest.fn().mockResolvedValue({ __typename: 'Query' }) };
    mcpClientEngine = { listTools: jest.fn().mockResolvedValue([]) };
    tokens = { forget: jest.fn() };
    service = new ConnectorsService(
      prisma,
      { get: () => KEY } as any,
      restEngine,
      {} as any,
      graphqlEngine,
      {} as any,
      mcpClientEngine,
      undefined,
      tokens,
    );
  });

  it.each([
    ['REST', () => restEngine.execute.mock.calls[0][0]],
    ['GRAPHQL', () => graphqlEngine.execute.mock.calls[0][0]],
    ['MCP', () => mcpClientEngine.listTools.mock.calls[0][0]],
  ])('Test connection of a %s connector names the connector to the engine', async (type, sent) => {
    prisma.connector.findUnique.mockResolvedValue({ ...row, type });

    await service.testConnection('conn-ffn');

    expect(sent()).toEqual(expect.objectContaining({ connectorId: 'conn-ffn' }));
  });

  it('forgets cached tokens when the authorization is stored', async () => {
    await service.updateAuthConfigMerge('conn-ffn', {
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });

    expect(tokens.forget).toHaveBeenCalledWith('conn-ffn');
  });

  it('forgets cached tokens when the whole auth config is replaced, and only then', async () => {
    await service.update('conn-ffn', { name: 'Renamed' });
    expect(tokens.forget).not.toHaveBeenCalled();

    await service.update('conn-ffn', { authConfig: { ...authConfig, refreshToken: 'rt-9' } });
    expect(tokens.forget).toHaveBeenCalledWith('conn-ffn');
  });
});
