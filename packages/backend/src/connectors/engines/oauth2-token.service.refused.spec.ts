import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  GOOGLE_TESTING_APP_HINT,
  OAuth2TokenService,
  isRefusedRefreshToken,
  refusedRefreshIssue,
} from './oauth2-token.service';
import { credentialRef } from './connector-auth-status.service';
import { encrypt } from '../../common/crypto/encryption.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = 'test-encryption-key-32-chars!!!!';
const DAY = 24 * 60 * 60 * 1000;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * A refresh token the provider refused (invalid_grant) is refused for good.
 * On 17 Oct 2026 a Google Search Console connector whose OAuth app was in
 * "Testing" lost its refresh token 7 days after authorization, and the
 * workspace's scheduled job then asked Google again 18 times an hour.
 */
describe('OAuth2TokenService: a refused refresh token', () => {
  let prisma: any;
  let authStatus: { mark: jest.Mock; clear: jest.Mock };
  let service: OAuth2TokenService;
  let row: Record<string, unknown> | null;

  const refused = () =>
    Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
    });

  const storedConfig = (overrides: Record<string, unknown> = {}) => ({
    tokenUrl: GOOGLE_TOKEN_URL,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'rt-dead',
    accessToken: 'at-expired',
    expiresAt: Date.now() - 1000,
    authorizedAt: new Date(Date.now() - 7 * DAY - 3_600_000).toISOString(),
    ...overrides,
  });

  const setRow = (authConfig: Record<string, unknown>, status: Record<string, unknown> = {}) => {
    row = {
      authConfig: encrypt(JSON.stringify(authConfig), KEY),
      envVars: {},
      headers: null,
      authStatus: null,
      authStatusRef: null,
      authStatusMessage: null,
      ...status,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    row = null;
    prisma = {
      connector: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async () => ({})),
      },
    };
    authStatus = { mark: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) };
    const config = { get: jest.fn().mockReturnValue(KEY) } as unknown as ConfigService;
    service = new OAuth2TokenService(prisma, config, authStatus as any);
  });

  it('marks the connector, and the next calls ask neither the token endpoint nor the API', async () => {
    const cfg = storedConfig({ authorizedAt: new Date(Date.now() - 2 * DAY).toISOString() });
    setRow(cfg);
    mockedAxios.post.mockRejectedValue(refused());

    const first = service.getAccessToken(cfg, 'conn-1');
    await expect(first).rejects.toMatchObject({ status: 401 });
    await expect(first).rejects.toThrow(/refused the refresh token.*Authorize with Provider/);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(authStatus.mark).toHaveBeenCalledWith('conn-1', {
      status: 'needs_reauth',
      code: 'refresh_refused',
      message: expect.stringContaining('oauth2.googleapis.com'),
      ref: credentialRef('rt-dead'),
    });

    // Eighteen more calls in the next hour: no token request at all.
    for (let i = 0; i < 18; i++) {
      await expect(service.getAccessToken(cfg, 'conn-1')).rejects.toMatchObject({ status: 401 });
    }
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    // The 401-retry path gets the same answer, without a request either.
    expect(await service.renewAfterRejection(cfg, 'conn-1', Date.now())).toBeNull();
    expect(service.renewalFailedError(cfg, 'conn-1')?.message).toMatch(/No request was sent to the API/);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('gives the Google "Testing" hint when the refusal comes 7 days after the authorization', async () => {
    const cfg = storedConfig();
    setRow(cfg);
    mockedAxios.post.mockRejectedValue(refused());

    const err = await service.getAccessToken(cfg, 'conn-google').catch((e) => e);
    expect(err.hint).toBe(GOOGLE_TESTING_APP_HINT);
    expect(err.message).toContain("OAuth app in your Google Cloud project is in 'Testing'");
    expect(authStatus.mark).toHaveBeenCalledWith(
      'conn-google',
      expect.objectContaining({ code: 'google_testing_7d', message: GOOGLE_TESTING_APP_HINT }),
    );
  });

  it('takes the refusal from the database after a restart, without asking the provider', async () => {
    const cfg = storedConfig();
    setRow(cfg, {
      authStatus: 'needs_reauth',
      authStatusRef: credentialRef('rt-dead'),
      authStatusMessage: GOOGLE_TESTING_APP_HINT,
    });

    const err = await service.getAccessToken(cfg, 'conn-restart').catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.hint).toBe(GOOGLE_TESTING_APP_HINT);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('refreshes again once the connector was authorized again, and clears the status', async () => {
    const dead = storedConfig();
    setRow(dead);
    mockedAxios.post.mockRejectedValueOnce(refused());
    await expect(service.getAccessToken(dead, 'conn-2')).rejects.toMatchObject({ status: 401 });

    // The OAuth callback stores the new tokens and calls forget().
    const fresh = storedConfig({ refreshToken: 'rt-new', authorizedAt: new Date().toISOString() });
    setRow(fresh, {
      authStatus: 'needs_reauth',
      authStatusRef: credentialRef('rt-dead'),
      authStatusMessage: GOOGLE_TESTING_APP_HINT,
    });
    service.forget('conn-2');
    mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'at-new', expires_in: 3600 } });

    expect(await service.getAccessToken(fresh, 'conn-2')).toBe('at-new');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(authStatus.clear).toHaveBeenCalledWith('conn-2');
  });

  it('looks at the database again after the recheck window, and a re-authorization there wins', async () => {
    const realNow = Date.now;
    let now = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const dead = storedConfig({ expiresAt: now - 1000 });
      setRow(dead);
      mockedAxios.post.mockRejectedValueOnce(refused());
      await expect(service.getAccessToken(dead, 'conn-3')).rejects.toBeDefined();

      // Another process stored a new authorization meanwhile.
      setRow(storedConfig({ refreshToken: 'rt-other', expiresAt: now - 1000 }));
      now += 11 * 60 * 1000;
      mockedAxios.post.mockResolvedValueOnce({ data: { access_token: 'at-other', expires_in: 3600 } });
      expect(await service.getAccessToken(dead, 'conn-3')).toBe('at-other');
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  it('does not mark anything for failures that may pass (5xx, network, wrong client)', async () => {
    const cfg = storedConfig();
    setRow(cfg);
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { status: 503, data: { error: 'temporarily_unavailable' } } }),
    );
    await service.getAccessToken(cfg, 'conn-4').catch(() => undefined);
    mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await service.getAccessToken(cfg, 'conn-4').catch(() => undefined);
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { status: 401, data: { error: 'invalid_client' } } }),
    );
    await service.getAccessToken(cfg, 'conn-4').catch(() => undefined);
    expect(authStatus.mark).not.toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });
});

describe('isRefusedRefreshToken', () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  it('recognises invalid_grant and the providers that word it differently', () => {
    expect(isRefusedRefreshToken(err(400, { error: 'invalid_grant' }))).toBe(true);
    expect(isRefusedRefreshToken(err(400, { status: 'BAD_REFRESH_TOKEN' }))).toBe(true);
    expect(isRefusedRefreshToken(err(401, { error: 'invalid_client' }))).toBe(false);
    expect(isRefusedRefreshToken(err(500, { error: 'invalid_grant' }))).toBe(false);
    expect(isRefusedRefreshToken(new Error('timeout'))).toBe(false);
  });
});

describe('refusedRefreshIssue', () => {
  const now = Date.parse('2026-10-17T22:44:00Z');
  const at = (days: number) => new Date(now - days * DAY).toISOString();

  it('blames the Google "Testing" status between 6.5 and 8 days after the authorization', () => {
    for (const days of [6.5, 7, 7.9]) {
      expect(refusedRefreshIssue({ tokenUrl: GOOGLE_TOKEN_URL, authorizedAt: at(days), now })).toEqual({
        code: 'google_testing_7d',
        message: GOOGLE_TESTING_APP_HINT,
      });
    }
  });

  it('is generic outside that window, for other providers, or without an authorization date', () => {
    for (const input of [
      { tokenUrl: GOOGLE_TOKEN_URL, authorizedAt: at(2) },
      { tokenUrl: GOOGLE_TOKEN_URL, authorizedAt: at(9) },
      { tokenUrl: GOOGLE_TOKEN_URL, authorizedAt: undefined },
      { tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', authorizedAt: at(7) },
    ]) {
      const issue = refusedRefreshIssue({ ...input, now, reason: 'HTTP 400: invalid_grant' });
      expect(issue.code).toBe('refresh_refused');
      expect(issue.message).toMatch(/refused the refresh token \(HTTP 400: invalid_grant\).*Authorize with Provider/);
    }
  });
});
