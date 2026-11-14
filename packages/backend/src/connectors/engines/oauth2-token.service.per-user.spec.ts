import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { OAuth2TokenService } from './oauth2-token.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';
import { userCredentialKey } from '../../common/credential-key.util';
import { mergeUserCredential } from '../user-credential.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = 'test-encryption-key-32-chars!!!!';
const CONNECTOR = 'cmv-mfr';

/**
 * A connector with per-user credentials: the client on the connector row, one
 * credential row per user. The provider rotates each user's refresh token and
 * refuses a token it does not know.
 */
function world() {
  const client = {
    tokenUrl: 'https://mcp.example.com/token',
    clientId: 'client-1',
    tokenAuthMethod: 'none',
  };
  let connectorRow = encrypt(JSON.stringify(client), KEY);
  const userRows = new Map<string, { authConfig: string; authStatus: string | null; authStatusRef: string | null; authStatusMessage: string | null }>();
  const valid = new Map<string, string>([
    ['rt-u1-0', 'u1'],
    ['rt-u2-0', 'u2'],
  ]);
  let issued = 0;

  for (const user of ['u1', 'u2']) {
    userRows.set(user, {
      authConfig: encrypt(
        JSON.stringify({ accessToken: `at-${user}-0`, refreshToken: `rt-${user}-0`, expiresAt: 0 }),
        KEY,
      ),
      authStatus: null,
      authStatusRef: null,
      authStatusMessage: null,
    });
  }

  mockedAxios.post.mockImplementation(async (_url: string, body: any) => {
    const rt = new URLSearchParams(body).get('refresh_token') ?? '';
    const user = valid.get(rt);
    if (!user) {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: 'invalid_grant' } },
      });
    }
    valid.delete(rt);
    issued += 1;
    const next = `rt-${user}-${issued}`;
    valid.set(next, user);
    return { data: { access_token: `at-${user}-${issued}`, refresh_token: next, expires_in: 3600 } };
  });

  const connector = {
    findUnique: jest.fn(async () => ({ authConfig: connectorRow, envVars: {}, headers: null })),
    update: jest.fn(async ({ data }: any) => {
      connectorRow = data.authConfig;
      return {};
    }),
  };
  const userConnectorCredential = {
    findUnique: jest.fn(async ({ where }: any) => userRows.get(where.connectorId_userId.userId) ?? null),
    update: jest.fn(async ({ where, data }: any) => {
      const row = userRows.get(where.connectorId_userId.userId)!;
      row.authConfig = data.authConfig;
      return {};
    }),
  };
  const authStatus = { mark: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) };
  const config = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
  const svc = new OAuth2TokenService({ connector, userConnectorCredential } as any, config, authStatus as any);

  /** What the tool path hands the engines for `user`: client + that user's tokens. */
  const callConfig = (user: string) =>
    mergeUserCredential(client, JSON.parse(decrypt(userRows.get(user)!.authConfig, KEY)));

  return {
    svc,
    connector,
    authStatus,
    callConfig,
    connectorAuth: () => JSON.parse(decrypt(connectorRow, KEY)),
    userTokens: (user: string) => JSON.parse(decrypt(userRows.get(user)!.authConfig, KEY)),
    revoke: (rt: string) => valid.delete(rt),
  };
}

describe('OAuth2TokenService with per-user credentials', () => {
  beforeEach(() => jest.clearAllMocks());

  it("renews each user's own token and stores it on that user's row only", async () => {
    const w = world();
    const k1 = userCredentialKey(CONNECTOR, 'u1');
    const k2 = userCredentialKey(CONNECTOR, 'u2');

    const t1 = await w.svc.getAccessToken(w.callConfig('u1'), k1);
    const t2 = await w.svc.getAccessToken(w.callConfig('u2'), k2);

    expect(t1).toMatch(/^at-u1-/);
    expect(t2).toMatch(/^at-u2-/);
    expect(w.userTokens('u1').refreshToken).toMatch(/^rt-u1-[1-9]/);
    expect(w.userTokens('u2').refreshToken).toMatch(/^rt-u2-[1-9]/);
    // The connector's own auth config is never written, and carries no token.
    expect(w.connector.update).not.toHaveBeenCalled();
    expect(w.connectorAuth().accessToken).toBeUndefined();
    expect(w.connectorAuth().refreshToken).toBeUndefined();
  });

  it('serves each user from their own cache entry', async () => {
    const w = world();
    const k1 = userCredentialKey(CONNECTOR, 'u1');
    const k2 = userCredentialKey(CONNECTOR, 'u2');
    const first = await w.svc.getAccessToken(w.callConfig('u1'), k1);
    // u2's call must not be answered with u1's freshly cached token.
    const second = await w.svc.getAccessToken(w.callConfig('u2'), k2);
    expect(first).not.toBe(second);
    expect(await w.svc.getAccessToken(w.callConfig('u1'), k1)).toBe(first);
  });

  it("marks only the refused user's credential, and the other user keeps working", async () => {
    const w = world();
    const k1 = userCredentialKey(CONNECTOR, 'u1');
    const k2 = userCredentialKey(CONNECTOR, 'u2');
    w.revoke('rt-u1-0');

    await expect(w.svc.getAccessToken(w.callConfig('u1'), k1)).rejects.toThrow(/refused/i);
    expect(w.authStatus.mark).toHaveBeenCalledWith(k1, expect.objectContaining({ status: 'needs_reauth' }));
    expect(w.authStatus.mark).not.toHaveBeenCalledWith(CONNECTOR, expect.anything());

    expect(await w.svc.getAccessToken(w.callConfig('u2'), k2)).toMatch(/^at-u2-/);
  });
});
