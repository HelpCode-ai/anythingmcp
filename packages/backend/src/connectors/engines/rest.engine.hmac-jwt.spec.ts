import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { RestEngine } from './rest.engine';
import { OAuth2TokenService } from './oauth2-token.service';
import { LoginTokenService } from './login-token.service';

/**
 * The Ghost adapter end to end through the engine: every call carries
 * `Authorization: Ghost <jwt>` signed from the stored Admin API key, and a
 * later call signs a fresh token instead of reusing an expired one.
 */
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: jest.fn(), AxiosError: actual.AxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

const ghost = require('../../adapters/intl/ghost.json') as {
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const KEY_ID = '6489a1b2c3d4e5f6a7b8c9d0';
const SECRET_HEX = '0f'.repeat(32);
const NOW = 1_794_240_000_000;

function resolved(): { baseUrl: string; authType: string; authConfig: Record<string, unknown> } {
  return JSON.parse(
    JSON.stringify(ghost.connector)
      .replace('{{GHOST_ADMIN_API_URL}}', 'https://example.ghost.io/ghost/api/admin')
      .replace('{{GHOST_ADMIN_API_KEY}}', `${KEY_ID}:${SECRET_HEX}`),
  );
}

describe('Ghost Admin API signing (HMAC jwt)', () => {
  let engine: RestEngine;
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ data: { posts: [] }, headers: {} });
    engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
    now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => now.mockRestore());

  const listPosts = async () => {
    const tool = ghost.tools.find((t) => t.name === 'ghost_list_posts')!;
    await engine.execute(resolved(), tool.endpointMapping as never, { limit: 1 });
    return mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0];
  };

  it('sends Authorization: Ghost <jwt> that Ghost would accept', async () => {
    const cfg = await listPosts();
    expect(cfg.url).toBe('https://example.ghost.io/ghost/api/admin/posts/');
    const auth = String(cfg.headers.Authorization);
    expect(auth).toMatch(/^Ghost [\w-]+\.[\w-]+\.[\w-]+$/);
    const token = auth.slice('Ghost '.length);
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toMatchObject({ alg: 'HS256', kid: KEY_ID });
    const payload = jwt.verify(token, Buffer.from(SECRET_HEX, 'hex'), {
      audience: '/admin/',
      clockTimestamp: NOW / 1000,
    }) as jwt.JwtPayload;
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it('signs a fresh token for a call made after the previous one expired', async () => {
    const first = String((await listPosts()).headers.Authorization);
    now.mockReturnValue(NOW + 6 * 60 * 1000);
    const second = String((await listPosts()).headers.Authorization);
    expect(second).not.toBe(first);
    const payload = jwt.decode(second.slice('Ghost '.length)) as jwt.JwtPayload;
    expect(payload.iat).toBe(NOW / 1000 + 360);
  });

  it('never sends the Admin API key itself', async () => {
    const cfg = await listPosts();
    expect(JSON.stringify(cfg.headers)).not.toContain(SECRET_HEX);
    expect(JSON.stringify(cfg.params ?? {})).not.toContain(SECRET_HEX);
  });
});
