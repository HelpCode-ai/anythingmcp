jest.mock('openid-client', () => ({}));

import { SocialProviderRegistry, SocialProviderError } from './social-providers';

const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';
const WORK_TID = '11111111-2222-3333-4444-555555555555';

function fakeLib(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const lib: any = {
    discovery: jest.fn(async () => ({ kind: 'discovered' })),
    Configuration: jest.fn(function (this: any, server: any) {
      this.server = server;
    }),
    buildAuthorizationUrl: jest.fn((_config: any, params: Record<string, string>) => {
      const url = new URL('https://idp.example/authorize');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url;
    }),
    authorizationCodeGrant: jest.fn(),
    fetchProtectedResource: jest.fn(),
    ...overrides,
  };
  return lib;
}

function registry(env: Record<string, string>, lib = fakeLib(), cloud = true) {
  const config = { get: (k: string) => env[k] } as any;
  return { reg: new SocialProviderRegistry(config, { isCloud: () => cloud } as any, lib), lib };
}

const ALL = {
  SOCIAL_GOOGLE_CLIENT_ID: 'g-id',
  SOCIAL_GOOGLE_CLIENT_SECRET: 'g-secret',
  SOCIAL_MICROSOFT_CLIENT_ID: 'm-id',
  SOCIAL_MICROSOFT_CLIENT_SECRET: 'm-secret',
  SOCIAL_GITHUB_CLIENT_ID: 'gh-id',
  SOCIAL_GITHUB_CLIENT_SECRET: 'gh-secret',
};

const authParams = {
  redirectUri: 'https://cloud.example/auth/social/x/callback',
  state: 'st',
  nonce: 'no',
  codeChallenge: 'cc',
};
const completion = (url = 'https://cloud.example/auth/social/x/callback?code=c&state=st') => ({
  currentUrl: new URL(url),
  state: 'st',
  nonce: 'no',
  codeVerifier: 'cv',
});

describe('SocialProviderRegistry', () => {
  it('enables only providers with both a client id and a secret', () => {
    const { reg } = registry({ SOCIAL_GOOGLE_CLIENT_ID: 'g', SOCIAL_GOOGLE_CLIENT_SECRET: 's', SOCIAL_GITHUB_CLIENT_ID: 'x' });
    expect(reg.enabled()).toEqual([{ id: 'google', name: 'Google' }]);
    expect(reg.get('github')).toBeNull();
    expect(reg.get('nope')).toBeNull();
  });

  it('enables nothing on a self-hosted instance, whatever is configured', () => {
    const { reg } = registry(ALL, fakeLib(), false);
    expect(reg.enabled()).toEqual([]);
    expect(reg.get('google')).toBeNull();
  });
});

describe('Google', () => {
  it('asks for openid email profile with PKCE and a nonce', async () => {
    const { reg } = registry(ALL);
    const url = await reg.get('google')!.authorizationUrl(authParams);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('trusts the email only when Google says it is verified', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant
      .mockResolvedValueOnce({ claims: () => ({ sub: 'g1', email: 'a@x.com', email_verified: true, name: 'A' }) })
      .mockResolvedValueOnce({ claims: () => ({ sub: 'g2', email: 'b@x.com', email_verified: false }) });
    const { reg } = registry(ALL, lib);
    await expect(reg.get('google')!.complete(completion())).resolves.toEqual({
      subject: 'g1',
      email: 'a@x.com',
      emailVerified: true,
      name: 'A',
    });
    await expect(reg.get('google')!.complete(completion())).resolves.toMatchObject({ emailVerified: false });
    expect(lib.authorizationCodeGrant.mock.calls[0][2]).toMatchObject({ expectedNonce: 'no', pkceCodeVerifier: 'cv' });
  });

  it('retries discovery after a failure instead of caching it', async () => {
    const lib = fakeLib();
    lib.discovery.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({});
    const { reg } = registry(ALL, lib);
    await expect(reg.get('google')!.authorizationUrl(authParams)).rejects.toThrow('down');
    await expect(reg.get('google')!.authorizationUrl(authParams)).resolves.toBeInstanceOf(URL);
  });
});

describe('Microsoft', () => {
  const grant = (claims: Record<string, unknown>) => ({ claims: () => claims });

  it('uses the /common discovery so the issuer is checked per tenant', async () => {
    const { reg, lib } = registry(ALL);
    await reg.get('microsoft')!.authorizationUrl(authParams);
    expect(lib.discovery.mock.calls[0][0].href).toBe('https://login.microsoftonline.com/common/v2.0');
  });

  it('trusts a personal Microsoft account email', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue(grant({ sub: 's', tid: MSA, email: 'p@outlook.com' }));
    const { reg } = registry(ALL, lib);
    await expect(reg.get('microsoft')!.complete(completion())).resolves.toMatchObject({
      email: 'p@outlook.com',
      emailVerified: true,
      tenantId: MSA,
    });
  });

  it('trusts a work email only with xms_edov', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant
      .mockResolvedValueOnce(grant({ sub: 's', tid: WORK_TID, email: 'w@corp.com', xms_edov: '1' }))
      .mockResolvedValueOnce(grant({ sub: 's', tid: WORK_TID, email: 'w@corp.com', xms_edov: true }))
      .mockResolvedValueOnce(grant({ sub: 's', tid: WORK_TID, email: 'w@corp.com' }));
    const { reg } = registry(ALL, lib);
    const ms = reg.get('microsoft')!;
    await expect(ms.complete(completion())).resolves.toMatchObject({ emailVerified: true });
    await expect(ms.complete(completion())).resolves.toMatchObject({ emailVerified: true });
    await expect(ms.complete(completion())).resolves.toMatchObject({ emailVerified: false });
  });

  it('never falls back to preferred_username (nOAuth)', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue(
      grant({ sub: 's', tid: WORK_TID, preferred_username: 'victim@corp.com', xms_edov: true }),
    );
    const { reg } = registry(ALL, lib);
    await expect(reg.get('microsoft')!.complete(completion())).resolves.toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  it('refuses a token without a tenant id', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue(grant({ sub: 's', email: 'x@y.z' }));
    const { reg } = registry(ALL, lib);
    await expect(reg.get('microsoft')!.complete(completion())).rejects.toBeInstanceOf(SocialProviderError);
  });

  it('drops an iss parameter from the callback before the exchange', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue(grant({ sub: 's', tid: MSA, email: 'p@outlook.com' }));
    const { reg } = registry(ALL, lib);
    await reg.get('microsoft')!.complete(
      completion('https://cloud.example/auth/social/microsoft/callback?code=c&state=st&iss=https%3A%2F%2Fx'),
    );
    const url: URL = lib.authorizationCodeGrant.mock.calls[0][1];
    expect(url.searchParams.has('iss')).toBe(false);
    expect(url.searchParams.get('code')).toBe('c');
  });
});

describe('GitHub', () => {
  const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

  it('asks for the profile and email scopes, with PKCE and no nonce', async () => {
    const { reg } = registry(ALL);
    const url = await reg.get('github')!.authorizationUrl(authParams);
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.has('nonce')).toBe(false);
    expect(url.searchParams.get('code_challenge')).toBe('cc');
  });

  it('keys on the numeric id and takes the primary verified email', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue({ access_token: 'at' });
    lib.fetchProtectedResource
      .mockResolvedValueOnce(json({ id: 42, login: 'octo', name: null }))
      .mockResolvedValueOnce(
        json([
          { email: 'old@x.com', primary: false, verified: true },
          { email: 'main@x.com', primary: true, verified: true },
        ]),
      );
    const { reg } = registry(ALL, lib);
    await expect(reg.get('github')!.complete(completion())).resolves.toEqual({
      subject: '42',
      email: 'main@x.com',
      emailVerified: true,
      name: 'octo',
    });
  });

  it('has no email when the primary one is not verified', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue({ access_token: 'at' });
    lib.fetchProtectedResource
      .mockResolvedValueOnce(json({ id: 7 }))
      .mockResolvedValueOnce(json([{ email: 'x@x.com', primary: true, verified: false }]));
    const { reg } = registry(ALL, lib);
    await expect(reg.get('github')!.complete(completion())).resolves.toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  it('fails when the profile cannot be read', async () => {
    const lib = fakeLib();
    lib.authorizationCodeGrant.mockResolvedValue({ access_token: 'at' });
    lib.fetchProtectedResource.mockResolvedValueOnce(json({}, false));
    const { reg } = registry(ALL, lib);
    await expect(reg.get('github')!.complete(completion())).rejects.toBeInstanceOf(SocialProviderError);
  });
});
