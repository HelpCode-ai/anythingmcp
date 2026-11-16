import { ConnectorsService } from './connectors.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';

/**
 * A password typed into a DATABASE connection string is stored in the
 * encrypted authConfig, not in the plaintext base_url (#1245).
 */
describe('ConnectorsService: DATABASE connection-string credentials', () => {
  const KEY = 'k'.repeat(48);
  const URL_WITH_PASSWORD = 'postgresql://app:s3cret@db.example.com:5432/shop';
  const STRIPPED = 'postgresql://db.example.com:5432/shop';

  let stored: Record<string, unknown>;
  const prisma = {
    connector: {
      create: jest.fn(async ({ data }: any) => data),
      findUnique: jest.fn(async () => stored),
      update: jest.fn(async ({ data }: any) => ({ ...stored, ...data })),
    },
  };
  const service = new ConnectorsService(
    prisma as any,
    { get: () => KEY } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const authConfigOf = (data: any) => JSON.parse(decrypt(data.authConfig, KEY));

  beforeEach(() => {
    jest.clearAllMocks();
    stored = {
      id: 'c1',
      type: 'DATABASE',
      baseUrl: STRIPPED,
      authConfig: null,
      tools: [],
      config: null,
    };
  });

  it('create stores the URL without the password and the credentials encrypted', async () => {
    await service.create('u1', 'org1', { name: 'Shop', type: 'DATABASE' as any, baseUrl: URL_WITH_PASSWORD });

    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(STRIPPED);
    expect(authConfigOf(data)).toEqual({ username: 'app', password: 's3cret' });
    expect(JSON.stringify(data)).not.toContain('s3cret');
  });

  it('create leaves a REST URL to the secret guard', async () => {
    await service.create('u1', 'org1', {
      name: 'Api',
      type: 'REST' as any,
      baseUrl: 'https://api.example.com',
    });
    expect(prisma.connector.create.mock.calls[0][0].data.authConfig).toBeNull();
  });

  it('create keeps credentials already given in authConfig and the URL as typed', async () => {
    await service.create('u1', 'org1', {
      name: 'Shop',
      type: 'DATABASE' as any,
      baseUrl: URL_WITH_PASSWORD,
      authConfig: { username: 'other', password: 'pw' },
    });
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(URL_WITH_PASSWORD);
    expect(authConfigOf(data)).toEqual({ username: 'other', password: 'pw' });
  });

  it('update moves a password typed into the URL, keeping the rest of authConfig', async () => {
    stored.authConfig = encrypt(JSON.stringify({ domain: 'CORP' }), KEY);

    await service.update('c1', { baseUrl: URL_WITH_PASSWORD });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(STRIPPED);
    expect(authConfigOf(data)).toEqual({ domain: 'CORP', username: 'app', password: 's3cret' });
  });

  it('update replaces moved credentials with ones retyped into the URL', async () => {
    // mssql, oracle and hana prefer authConfig, so a password left in the URL
    // would be ignored and the old one used.
    stored.baseUrl = 'mssql://db.example.com:1433/shop';
    stored.authConfig = encrypt(JSON.stringify({ domain: 'CORP', username: 'sa', password: 'old' }), KEY);

    await service.update('c1', { baseUrl: 'mssql://sa:n3w@db.example.com:1433/shop' });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe('mssql://db.example.com:1433/shop');
    expect(authConfigOf(data)).toEqual({ domain: 'CORP', username: 'sa', password: 'n3w' });
  });

  it.each([
    ['only a username', 'mssql://bob@db.example.com:1433/shop'],
    ['variable references', 'mssql://{{DB_USER}}:{{DB_PASSWORD}}@db.example.com:1433/shop'],
  ])('update lets credentials retyped as %s replace the moved ones', async (_case, typed) => {
    stored.baseUrl = 'mssql://db.example.com:1433/shop';
    stored.authConfig = encrypt(JSON.stringify({ domain: 'CORP', username: 'sa', password: 'old' }), KEY);

    await service.update('c1', { baseUrl: typed });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(typed);
    expect(authConfigOf(data)).toEqual({ domain: 'CORP' });
  });

  it('update keeps moved credentials when the URL becomes multi-host MongoDB', async () => {
    // `new URL` cannot read it; the engine puts the credentials back in.
    stored.baseUrl = 'mongodb://m1.example.com:27017/shop';
    stored.authConfig = encrypt(JSON.stringify({ username: 'app', password: 's3cret' }), KEY);
    const edited = 'mongodb://m1.example.com:27017,m2.example.com:27017/shop';

    await service.update('c1', { baseUrl: edited });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(edited);
    expect(data).not.toHaveProperty('authConfig');
  });

  it('update keeps moved credentials when only the host changes', async () => {
    stored.authConfig = encrypt(JSON.stringify({ username: 'app', password: 's3cret' }), KEY);
    const edited = 'postgresql://db2.example.com:5432/shop';

    await service.update('c1', { baseUrl: edited });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(edited);
    expect(data).not.toHaveProperty('authConfig');
  });

  it('update leaves the URL alone when its credentials are unchanged and authConfig holds some', async () => {
    stored.baseUrl = URL_WITH_PASSWORD;
    stored.authConfig = encrypt(JSON.stringify({ username: 'other', password: 'pw' }), KEY);
    const edited = 'postgresql://app:s3cret@db2.example.com:5432/shop';

    await service.update('c1', { baseUrl: edited });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(edited);
    expect(data).not.toHaveProperty('authConfig');
  });

  it('update without a base URL does not touch authConfig', async () => {
    await service.update('c1', { name: 'Renamed' });
    expect(prisma.connector.update.mock.calls[0][0].data).toEqual({ name: 'Renamed' });
  });
});
