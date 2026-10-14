import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { OAuth2TokenService } from './oauth2-token.service';
import { decrypt, encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = 'test-encryption-key-32-chars!!!!';
const CONNECTOR = 'cmv-cloudinary';

/**
 * A token endpoint that rotates the refresh token on every use, as
 * Cloudinary's MCP server does: only the latest refresh token is accepted,
 * an older one is answered with invalid_grant. Access tokens live 5 minutes.
 */
function rotatingProvider() {
  let valid = 'rt-0';
  let issued = 0;
  const sent: string[] = [];
  mockedAxios.post.mockImplementation(async (_url: string, body: any) => {
    const refreshToken = new URLSearchParams(body).get('refresh_token') ?? '';
    sent.push(refreshToken);
    // The provider answers after a moment, so concurrent callers overlap.
    await new Promise((r) => setTimeout(r, 10));
    if (refreshToken !== valid) {
      throw Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
            error_description: 'Failed to refresh token: Invalid or expired refresh token',
          },
        },
      });
    }
    issued += 1;
    valid = `rt-${issued}`;
    return { data: { access_token: `at-${issued}`, refresh_token: valid, expires_in: 300 } };
  });
  return { issued: () => issued, sent };
}

/**
 * The connectors table, shared by every service instance (= every process).
 * With `withLock`, `$transaction` emulates Postgres' transaction-scoped
 * advisory lock: `SELECT pg_advisory_xact_lock(...)` waits while another
 * transaction holds the same key, and the lock goes when the transaction ends.
 */
function connectorsTable(initial: Record<string, unknown>, opts: { withLock?: boolean } = {}) {
  let row = encrypt(JSON.stringify(initial), KEY);
  const held = new Map<string, Promise<void>>();
  const connector = {
    findUnique: jest.fn(async () => ({ authConfig: row, envVars: {}, headers: null })),
    update: jest.fn(async ({ data }: { data: { authConfig: string } }) => {
      row = data.authConfig;
      return {};
    }),
  };
  const lockedKeys: string[] = [];
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    let key: string | undefined;
    let release: () => void = () => undefined;
    const tx = {
      connector,
      $executeRaw: async (_sql: TemplateStringsArray, lockKey: string) => {
        while (held.has(lockKey)) await held.get(lockKey);
        key = lockKey;
        lockedKeys.push(lockKey);
        held.set(lockKey, new Promise<void>((r) => (release = r)));
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      if (key) {
        held.delete(key);
        release();
      }
    }
  });
  const prisma: Record<string, unknown> = { connector };
  if (opts.withLock) prisma.$transaction = $transaction;
  return {
    prisma,
    connector,
    $transaction,
    lockedKeys,
    stored: () => JSON.parse(decrypt(row, KEY)) as Record<string, unknown>,
  };
}

function service(prisma: unknown): OAuth2TokenService {
  const config = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
  return new OAuth2TokenService(prisma as any, config);
}

describe('OAuth2TokenService: concurrent renewals of a rotating refresh token (Cloudinary)', () => {
  const t0 = Date.parse('2026-10-14T06:11:43.000Z');
  let now = t0;
  let clock: jest.SpyInstance;

  // What the MCP OAuth callback stores after the authorization.
  const authorized = () => ({
    tokenUrl: 'https://asset-management.mcp.cloudinary.com/token',
    clientId: 'mcp_client_x',
    clientSecret: 'secret',
    tokenAuthMethod: 'client_secret_post',
    resource: 'https://asset-management.mcp.cloudinary.com/mcp',
    accessToken: 'at-0',
    refreshToken: 'rt-0',
    expiresIn: 300,
    expiresAt: t0 + 300_000,
    authorizedAt: new Date(t0).toISOString(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    now = t0;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => clock.mockRestore());

  it('keeps working past several 5-minute tokens when every call parses a fresh authConfig (the /mcp tool path)', async () => {
    const provider = rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    const svc = service(db.prisma);
    // The tool registry holds the authConfig as a JSON string taken at load
    // time, and the tool path parses it again on every call.
    const snapshot = JSON.stringify(authorized());

    expect(await svc.getAccessToken(JSON.parse(snapshot), CONNECTOR)).toBe('at-0');

    now = t0 + 20 * 60_000;
    expect(await svc.getAccessToken(JSON.parse(snapshot), CONNECTOR)).toBe('at-1');
    now += 60_000;
    // Served from the cache: no second renewal within the token's life.
    expect(await svc.getAccessToken(JSON.parse(snapshot), CONNECTOR)).toBe('at-1');

    now += 10 * 60_000;
    expect(await svc.getAccessToken(JSON.parse(snapshot), CONNECTOR)).toBe('at-2');
    now += 10 * 60_000;
    expect(await svc.getAccessToken(JSON.parse(snapshot), CONNECTOR)).toBe('at-3');

    // Each renewal spent the refresh token the previous one stored.
    expect(provider.sent).toEqual(['rt-0', 'rt-1', 'rt-2']);
    expect(db.stored().refreshToken).toBe('rt-3');
    expect(db.stored().accessToken).toBe('at-3');
  });

  it('renews once for two concurrent calls in one process, and stores the rotated token before either returns', async () => {
    const provider = rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    const svc = service(db.prisma);
    now = t0 + 20 * 60_000;

    const [a, b] = await Promise.all([
      svc.getAccessToken(authorized(), CONNECTOR),
      svc.getAccessToken(authorized(), CONNECTOR),
    ]);

    expect([a, b]).toEqual(['at-1', 'at-1']);
    expect(provider.issued()).toBe(1);
    expect(provider.sent).toEqual(['rt-0']);
    expect(db.stored().refreshToken).toBe('rt-1');
    expect(db.lockedKeys).toEqual([`amcp:oauth2-refresh:${CONNECTOR}`]);
  });

  it('renews once for two processes renewing at the same moment: the second takes the token the first stored', async () => {
    const provider = rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    // Blue and green during a deploy: two services, one database.
    const blue = service(db.prisma);
    const green = service(db.prisma);
    now = t0 + 20 * 60_000;

    const [a, b] = await Promise.all([
      blue.getAccessToken(authorized(), CONNECTOR),
      green.getAccessToken(authorized(), CONNECTOR),
    ]);

    expect([a, b]).toEqual(['at-1', 'at-1']);
    expect(provider.sent).toEqual(['rt-0']);
    expect(db.stored().refreshToken).toBe('rt-1');

    // And the process that adopted it renews with the stored refresh token later.
    now += 10 * 60_000;
    expect(await green.getAccessToken(authorized(), CONNECTOR)).toBe('at-2');
    expect(provider.sent).toEqual(['rt-0', 'rt-1']);
  });

  it('without the database lock, the same two processes lose the connector (why the lock exists)', async () => {
    const provider = rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: false });
    const blue = service(db.prisma);
    const green = service(db.prisma);
    now = t0 + 20 * 60_000;

    const results = await Promise.all([
      blue.refreshToken(authorized(), CONNECTOR),
      green.refreshToken(authorized(), CONNECTOR),
    ]);

    expect(provider.sent).toEqual(['rt-0', 'rt-0']);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it('stores the rotated token again when the write under the lock failed', async () => {
    rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    db.connector.update.mockRejectedValueOnce(new Error('connection reset'));
    const svc = service(db.prisma);
    now = t0 + 20 * 60_000;

    expect(await svc.getAccessToken(authorized(), CONNECTOR)).toBe('at-1');
    expect(db.connector.update).toHaveBeenCalledTimes(2);
    expect(db.stored().refreshToken).toBe('rt-1');
  });

  it('stores the rotated token when the lock transaction fails after the token endpoint answered', async () => {
    rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    const inner = db.$transaction.getMockImplementation()!;
    db.$transaction.mockImplementationOnce(async (fn: any) => {
      await inner(fn);
      throw new Error('Transaction already closed: commit timed out');
    });
    const svc = service(db.prisma);
    now = t0 + 20 * 60_000;

    expect(await svc.getAccessToken(authorized(), CONNECTOR)).toBe('at-1');
    expect(db.stored().refreshToken).toBe('rt-1');
  });

  it('still renews, without the lock, when no database connection is free for it', async () => {
    const provider = rotatingProvider();
    const db = connectorsTable(authorized(), { withLock: true });
    db.$transaction.mockRejectedValueOnce(new Error('Unable to start a transaction in the given time.'));
    const svc = service(db.prisma);
    now = t0 + 20 * 60_000;

    expect(await svc.getAccessToken(authorized(), CONNECTOR)).toBe('at-1');
    expect(provider.sent).toEqual(['rt-0']);
    expect(db.stored().refreshToken).toBe('rt-1');
  });

  describe('after the API refused a token (401)', () => {
    it('takes a token stored after the refused request was sent, without renewing', async () => {
      const provider = rotatingProvider();
      const sentAt = t0 + 20 * 60_000;
      const db = connectorsTable({
        ...authorized(),
        accessToken: 'at-other-process',
        refreshToken: 'rt-0',
        expiresAt: sentAt + 290_000,
        lastRefreshedAt: new Date(sentAt + 500).toISOString(),
      }, { withLock: true });
      const svc = service(db.prisma);
      now = sentAt + 1_000;

      expect(await svc.renewAfterRejection(authorized(), CONNECTOR, sentAt)).toBe('at-other-process');
      expect(provider.sent).toEqual([]);
    });

    it('renews when the stored token is the one the API refused, even if it has not expired', async () => {
      const provider = rotatingProvider();
      const sentAt = t0 + 60_000;
      const db = connectorsTable(authorized(), { withLock: true });
      const svc = service(db.prisma);
      now = sentAt + 1_000;

      expect(await svc.renewAfterRejection(authorized(), CONNECTOR, sentAt)).toBe('at-1');
      expect(provider.sent).toEqual(['rt-0']);
    });
  });
});
