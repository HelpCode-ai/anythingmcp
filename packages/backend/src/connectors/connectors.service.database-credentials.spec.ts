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

  it('update leaves the URL alone when the connector already holds credentials', async () => {
    stored.authConfig = encrypt(JSON.stringify({ username: 'app', password: 'old' }), KEY);

    await service.update('c1', { baseUrl: URL_WITH_PASSWORD });

    const data = prisma.connector.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe(URL_WITH_PASSWORD);
    expect(data).not.toHaveProperty('authConfig');
  });

  it('update without a base URL does not touch authConfig', async () => {
    await service.update('c1', { name: 'Renamed' });
    expect(prisma.connector.update.mock.calls[0][0].data).toEqual({ name: 'Renamed' });
  });
});
