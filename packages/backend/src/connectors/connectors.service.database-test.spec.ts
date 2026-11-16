import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';

/**
 * "Test connection" on a DATABASE connector connects to the same string a
 * tool call does: {{VAR}} in the connection string is resolved from the
 * connector's variables first. It used to hand the stored template to the
 * driver, so `postgresql://{{DB_HOST}}:5432/{{DB_NAME}}` failed the test
 * while its tools worked.
 */
describe('ConnectorsService.testConnection for DATABASE connectors', () => {
  const KEY = 'k'.repeat(48);
  const databaseEngine = { testConnection: jest.fn(), execute: jest.fn() };
  const prisma = { connector: { findUnique: jest.fn() } };
  const service = new ConnectorsService(
    prisma as any,
    { get: () => KEY } as any,
    {} as any,
    {} as any,
    {} as any,
    databaseEngine as any,
    {} as any,
  );

  const connector = (over: Record<string, unknown> = {}) =>
    ({
      id: 'c1',
      name: 'Shop database',
      type: 'DATABASE',
      baseUrl: 'postgresql://{{DB_HOST}}:5432/{{DB_NAME}}',
      authType: 'NONE',
      authConfig: encrypt(JSON.stringify({ username: 'app', password: '{{DB_PASSWORD}}' }), KEY),
      headers: null,
      specUrl: null,
      healthcheckPath: null,
      credentialScope: 'SHARED',
      organizationId: 'org1',
      config: null,
      envVars: { DB_HOST: 'db.example.com', DB_NAME: 'shop', DB_PASSWORD: 's3cret' },
      ...over,
    }) as any;

  beforeEach(() => {
    databaseEngine.testConnection.mockReset().mockResolvedValue(undefined);
    databaseEngine.execute.mockReset().mockResolvedValue([]);
  });

  const test = (c: any) => {
    jest.spyOn(service, 'findById').mockResolvedValue(c);
    return service.testConnection('c1');
  };

  it('tests the connection string with its variables filled in', async () => {
    await expect(test(connector())).resolves.toMatchObject({ ok: true, kind: 'ok' });

    expect(databaseEngine.testConnection).toHaveBeenCalledWith({
      baseUrl: 'postgresql://db.example.com:5432/shop',
      authType: 'NONE',
      authConfig: { username: 'app', password: 's3cret' },
    });
  });

  it('tests the string a tool call runs on', async () => {
    const c = connector();
    await test(c);
    await service.executeConnectorCall(c, { method: 'query', path: 'SELECT 1' }, {});

    const tested = databaseEngine.testConnection.mock.calls[0][0];
    const called = databaseEngine.execute.mock.calls[0][0];
    expect(tested.baseUrl).toBe(called.baseUrl);
    expect(tested.authConfig).toEqual(called.authConfig);
  });

  it('passes a connection string without variables through as stored', async () => {
    await test(connector({ baseUrl: 'mysql://db.example.com:3306/shop', envVars: null, authConfig: null }));

    expect(databaseEngine.testConnection).toHaveBeenCalledWith({
      baseUrl: 'mysql://db.example.com:3306/shop',
      authType: 'NONE',
      authConfig: undefined,
    });
  });

  it('names the variable that is still missing instead of connecting to "{{DB_HOST}}"', async () => {
    const result = await test(connector({ envVars: { DB_NAME: 'shop', DB_PASSWORD: 's3cret' } }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('DB_HOST');
    expect(databaseEngine.testConnection).not.toHaveBeenCalled();
  });
});
