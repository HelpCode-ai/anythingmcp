import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import {
  LoginTokenService,
  jsonPath,
  interpolateDeep,
  extractSetCookieValue,
  LoginTokenAuthConfig,
} from './login-token.service';
import { encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('jsonPath helper', () => {
  it('reads nested object path', () => {
    expect(jsonPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('reads array index path', () => {
    expect(jsonPath({ arr: [{ id: 9 }] }, 'arr[0].id')).toBe(9);
  });

  it('returns undefined for missing keys', () => {
    expect(jsonPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('handles null root', () => {
    expect(jsonPath(null, 'a.b')).toBeUndefined();
  });
});

describe('interpolateDeep helper', () => {
  it('substitutes full-string references and preserves structure', () => {
    const out = interpolateDeep(
      { query: 'mutation', variables: { email: '${u}', otp: '${o}' } },
      { u: 'a@b.co', o: '' },
    );
    expect(out).toEqual({
      query: 'mutation',
      variables: { email: 'a@b.co', otp: '' },
    });
  });

  it('interpolates embedded placeholders in strings', () => {
    expect(interpolateDeep('/users/${u}', { u: 'x' })).toBe('/users/x');
  });

  it('leaves non-string leaves untouched', () => {
    expect(interpolateDeep({ n: 42, b: true }, {})).toEqual({ n: 42, b: true });
  });
});

describe('LoginTokenService', () => {
  let service: LoginTokenService;
  let mockPrisma: any;
  let mockConfig: jest.Mocked<ConfigService>;
  const encryptionKey = 'test-encryption-key-32-chars-ok!';

  const baseAuth: LoginTokenAuthConfig = {
    loginUrl: 'https://api.example.com/graphql',
    username: 'user@example.com',
    password: 'plain-password',
    aud: 'test-client',
    loginBody: {
      query:
        'mutation SignIn($email: String!, $password: String!) { signIn(input: {email: $email, password: $password}) { token aud expiresAt } }',
      variables: {
        email: '${username}',
        password: '${passwordHashed}',
      },
    },
    passwordHashing: {
      scheme: 'bcrypt',
      saltSource: {
        type: 'fetch',
        method: 'GET',
        url: 'https://api.example.com/users/${username}',
        responsePath: 'salt',
      },
      outputParam: 'passwordHashed',
    },
    tokenJsonPath: 'data.signIn.token',
    audJsonPath: 'data.signIn.aud',
    expiryJsonPath: 'data.signIn.expiresAt',
    expiryFormat: 'iso8601',
    tokenTTLSeconds: 30 * 24 * 60 * 60,
  };

  beforeEach(() => {
    mockPrisma = {
      connectorAuthCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    mockConfig = { get: jest.fn().mockReturnValue(encryptionKey) } as any;
    service = new LoginTokenService(mockPrisma, mockConfig);
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue(encryptionKey);
  });

  it('fetches salt, bcrypt-hashes password, then logs in and caches token', async () => {
    const salt = bcrypt.genSaltSync(4);
    const expectedHash = bcrypt.hashSync('plain-password', salt);

    (mockedAxios as unknown as jest.Mock).mockImplementation(
      async (config: any) => {
        if (config.url.includes('/users/')) {
          return { data: { salt } };
        }
        // Login POST: verify the bcrypt hash made it into the request body
        const body = config.data;
        expect(body.variables.password).toBe(expectedHash);
        expect(body.variables.email).toBe('user@example.com');
        return {
          data: {
            data: {
              signIn: {
                token: 'jwt-abc',
                aud: 'test-client',
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
        };
      },
    );

    const bundle = await service.getToken(baseAuth, 'conn-1');

    expect(bundle.token).toBe('jwt-abc');
    expect(bundle.aud).toBe('test-client');
    expect(bundle.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    expect(mockPrisma.connectorAuthCache.upsert).toHaveBeenCalled();
  });

  it('returns cached token without re-logging in on subsequent calls', async () => {
    const salt = bcrypt.genSaltSync(4);
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      if (config.url.includes('/users/')) return { data: { salt } };
      return {
        data: {
          data: {
            signIn: {
              token: 'jwt-cached',
              aud: 'test-client',
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        },
      };
    });

    await service.getToken(baseAuth, 'conn-2');
    const callsAfterFirst = (mockedAxios as unknown as jest.Mock).mock.calls.length;

    const second = await service.getToken(baseAuth, 'conn-2');
    expect(second.token).toBe('jwt-cached');

    const callsAfterSecond = (mockedAxios as unknown as jest.Mock).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // no new HTTP calls
  });

  it('hydrates token from DB when memory cache is cold', async () => {
    const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    mockPrisma.connectorAuthCache.findUnique.mockResolvedValue({
      token: encrypt('persisted-token', encryptionKey),
      metadata: { aud: 'test-client' },
      expiresAt,
    });

    const bundle = await service.getToken(baseAuth, 'conn-3');
    expect(bundle.token).toBe('persisted-token');
    expect(bundle.aud).toBe('test-client');
    expect(mockedAxios as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('forceRelogin bypasses cache and re-issues token', async () => {
    const salt = bcrypt.genSaltSync(4);
    let loginCount = 0;
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      if (config.url.includes('/users/')) return { data: { salt } };
      loginCount++;
      return {
        data: {
          data: {
            signIn: {
              token: `jwt-${loginCount}`,
              aud: 'test-client',
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        },
      };
    });

    const first = await service.getToken(baseAuth, 'conn-4');
    const refreshed = await service.forceRelogin(baseAuth, 'conn-4');
    expect(first.token).toBe('jwt-1');
    expect(refreshed.token).toBe('jwt-2');
  });

  it('falls back to tokenTTLSeconds when expiryJsonPath is missing in response', async () => {
    const salt = bcrypt.genSaltSync(4);
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      if (config.url.includes('/users/')) return { data: { salt } };
      return {
        data: { data: { signIn: { token: 'jwt-ttl', aud: 'x' } } },
      };
    });

    const bundle = await service.getToken(
      { ...baseAuth, tokenTTLSeconds: 60 },
      'conn-5',
    );
    expect(bundle.expiresAt).toBeGreaterThan(Date.now() + 50 * 1000);
    expect(bundle.expiresAt).toBeLessThan(Date.now() + 70 * 1000);
  });

  it('supports static salt source', async () => {
    const staticSalt = bcrypt.genSaltSync(4);
    const expectedHash = bcrypt.hashSync('plain-password', staticSalt);
    let observed = '';
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      observed = config.data.variables.password;
      return {
        data: { data: { signIn: { token: 'jwt-static', aud: 'x' } } },
      };
    });

    const auth: LoginTokenAuthConfig = {
      ...baseAuth,
      passwordHashing: {
        scheme: 'bcrypt',
        saltSource: { type: 'static', value: staticSalt },
        outputParam: 'passwordHashed',
      },
    };
    const bundle = await service.getToken(auth, 'conn-6');
    expect(bundle.token).toBe('jwt-static');
    expect(observed).toBe(expectedHash);
  });

  it('passes plain password through when passwordHashing.scheme=none', async () => {
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      expect(config.data.variables.password).toBe('plain-password');
      return {
        data: { data: { signIn: { token: 'jwt-plain', aud: 'x' } } },
      };
    });

    const auth: LoginTokenAuthConfig = {
      ...baseAuth,
      passwordHashing: { scheme: 'none' },
    };
    const bundle = await service.getToken(auth, 'conn-7');
    expect(bundle.token).toBe('jwt-plain');
  });

  it('throws a clear error when tokenJsonPath does not resolve', async () => {
    (mockedAxios as unknown as jest.Mock).mockImplementation(async (config: any) => {
      if (config.url.includes('/users/')) {
        return { data: { salt: bcrypt.genSaltSync(4) } };
      }
      return { data: { data: { signIn: null, errors: [{ message: 'bad creds' }] } } };
    });

    await expect(service.getToken(baseAuth, 'conn-8')).rejects.toThrow(
      /token not found/,
    );
  });
});

describe('extractSetCookieValue helper', () => {
  it('reads single Set-Cookie string', () => {
    const headers = {
      'set-cookie': 'B1SESSION=ABC123; Path=/; HttpOnly',
    };
    expect(extractSetCookieValue(headers, 'B1SESSION')).toBe('ABC123');
  });

  it('reads from an array of Set-Cookie headers and skips non-matching', () => {
    const headers = {
      'set-cookie': [
        'route=node1; Path=/',
        'B1SESSION=XYZ789; Path=/; Secure; HttpOnly',
      ],
    };
    expect(extractSetCookieValue(headers, 'B1SESSION')).toBe('XYZ789');
  });

  it('returns null when the named cookie is absent', () => {
    expect(
      extractSetCookieValue({ 'set-cookie': 'other=1' }, 'B1SESSION'),
    ).toBeNull();
  });

  it('handles missing headers safely', () => {
    expect(extractSetCookieValue(undefined, 'B1SESSION')).toBeNull();
    expect(extractSetCookieValue({}, 'B1SESSION')).toBeNull();
  });
});

describe('LoginTokenService — tokenSource=cookie (SAP B1 pattern)', () => {
  let service: LoginTokenService;
  let mockPrisma: any;
  let mockConfigService: jest.Mocked<ConfigService>;
  const encryptionKey = 'test-encryption-key-32-chars!!!!';

  beforeEach(() => {
    mockPrisma = { connector: { findUnique: jest.fn(), update: jest.fn() } } as any;
    mockConfigService = { get: jest.fn().mockReturnValue(encryptionKey) } as any;
    service = new LoginTokenService(mockPrisma, mockConfigService);
    jest.clearAllMocks();
  });

  const cookieAuth: LoginTokenAuthConfig = {
    loginUrl: 'https://b1.example.com:50000/b1s/v2/Login',
    loginMethod: 'POST',
    loginBody: {
      UserName: '${username}',
      Password: '${password}',
      CompanyDB: 'SBODEMO',
    },
    username: 'manager',
    password: 'secret',
    tokenSource: 'cookie',
    cookieName: 'B1SESSION',
    tokenJsonPath: 'SessionId',
    tokenTTLSeconds: 1500,
    proactiveRefreshSeconds: 120,
    headerName: 'Cookie',
    headerTemplate: 'B1SESSION=${token}',
  };

  it('extracts B1SESSION from the Set-Cookie header on login', async () => {
    (mockedAxios as unknown as jest.Mock).mockResolvedValue({
      data: { SessionId: 'SID-IGNORED' },
      headers: {
        'set-cookie': 'B1SESSION=cookie-abc-123; Path=/; HttpOnly',
      },
    });

    const bundle = await service.getToken(cookieAuth, 'conn-b1');
    expect(bundle.token).toBe('cookie-abc-123');
    expect(bundle.expiresAt).toBeGreaterThan(Date.now() + 1_400_000);
  });

  it('throws when cookieName is missing', async () => {
    const broken = { ...cookieAuth, cookieName: undefined };
    (mockedAxios as unknown as jest.Mock).mockResolvedValue({
      data: {},
      headers: { 'set-cookie': 'whatever=1' },
    });
    await expect(service.getToken(broken, 'conn-bad')).rejects.toThrow(
      /cookieName/,
    );
  });

  it('throws when the named cookie is absent from the response', async () => {
    (mockedAxios as unknown as jest.Mock).mockResolvedValue({
      data: {},
      headers: { 'set-cookie': 'OTHER=1; Path=/' },
    });
    await expect(service.getToken(cookieAuth, 'conn-x')).rejects.toThrow(
      /B1SESSION/,
    );
  });
});
