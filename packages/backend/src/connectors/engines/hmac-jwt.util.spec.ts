import * as jwt from 'jsonwebtoken';
import { HmacJwtError, hmacJwtHeader, isHmacJwtSignature, signHmacJwt } from './hmac-jwt.util';

// A made-up Ghost Admin API key: 24 hex characters, a colon, 64 hex characters.
const KEY_ID = '6489a1b2c3d4e5f6a7b8c9d0';
const SECRET_HEX = 'a1'.repeat(32);
const ADMIN_KEY = `${KEY_ID}:${SECRET_HEX}`;
const NOW = 1_794_240_000_000; // 2026-11-09T15:20:00Z

const ghost = {
  key: ADMIN_KEY,
  keyFormat: 'id:secret',
  secretEncoding: 'hex',
  algorithm: 'HS256',
  ttlSeconds: 300,
  claims: { aud: '/admin/' },
};

function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

describe('signHmacJwt', () => {
  it('signs the token Ghost asks for: kid, HS256 with the hex-decoded secret, aud /admin/, 5 minutes', () => {
    const token = signHmacJwt(ghost, NOW);
    expect(decodeHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT', kid: KEY_ID });
    const payload = jwt.verify(token, Buffer.from(SECRET_HEX, 'hex'), {
      audience: '/admin/',
      algorithms: ['HS256'],
      clockTimestamp: NOW / 1000,
    }) as jwt.JwtPayload;
    expect(payload.iat).toBe(NOW / 1000);
    expect(payload.exp).toBe(NOW / 1000 + 300);
  });

  it('is not valid when signed with the secret as text instead of hex bytes', () => {
    const token = signHmacJwt(ghost, NOW);
    expect(() =>
      jwt.verify(token, SECRET_HEX, { algorithms: ['HS256'], clockTimestamp: NOW / 1000 }),
    ).toThrow(/invalid signature/);
  });

  it('signs a new token on each call, so nothing expires on the connector', () => {
    const first = signHmacJwt(ghost, NOW);
    const later = signHmacJwt(ghost, NOW + 10 * 60 * 1000);
    expect(later).not.toBe(first);
    const payload = jwt.decode(later) as jwt.JwtPayload;
    expect(payload.iat).toBe(NOW / 1000 + 600);
  });

  it('keeps iat and exp its own even when claims name them', () => {
    const payload = jwt.decode(
      signHmacJwt({ ...ghost, claims: { aud: '/admin/', exp: 9_999_999_999, iat: 1 } }, NOW),
    ) as jwt.JwtPayload;
    expect(payload.iat).toBe(NOW / 1000);
    expect(payload.exp).toBe(NOW / 1000 + 300);
  });

  it('caps the lifetime at one hour and defaults to five minutes', () => {
    const capped = jwt.decode(signHmacJwt({ ...ghost, ttlSeconds: 86_400 }, NOW)) as jwt.JwtPayload;
    expect(capped.exp! - capped.iat!).toBe(3600);
    const { ttlSeconds: _unused, ...noTtl } = ghost;
    const fallback = jwt.decode(signHmacJwt(noTtl, NOW)) as jwt.JwtPayload;
    expect(fallback.exp! - fallback.iat!).toBe(300);
  });

  it('accepts a separate keyId and secret, and HS512', () => {
    const token = signHmacJwt({ keyId: 'k1', secret: 'plain-secret', algorithm: 'HS512' }, NOW);
    expect(decodeHeader(token)).toEqual({ alg: 'HS512', typ: 'JWT', kid: 'k1' });
    expect(() =>
      jwt.verify(token, 'plain-secret', { algorithms: ['HS512'], clockTimestamp: NOW / 1000 }),
    ).not.toThrow();
  });

  describe('errors name the problem and never the key', () => {
    const message = (cfg: Record<string, unknown>) => {
      try {
        signHmacJwt(cfg, NOW);
      } catch (err) {
        expect(err).toBeInstanceOf(HmacJwtError);
        return (err as Error).message;
      }
      throw new Error('expected signHmacJwt to throw');
    };

    it('a Content API key (no colon)', () => {
      const msg = message({ ...ghost, key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3' });
      expect(msg).toMatch(/<id>:<secret>/);
      expect(msg).not.toContain('a1b2c3');
    });

    it('a secret that is not hex', () => {
      const msg = message({ ...ghost, key: `${KEY_ID}:not-hex-at-all` });
      expect(msg).toMatch(/not hexadecimal/);
      expect(msg).not.toContain('not-hex-at-all');
    });

    it('a key left as a placeholder', () => {
      expect(message({ ...ghost, key: '{{GHOST_ADMIN_API_KEY}}' })).toMatch(
        /\{\{GHOST_ADMIN_API_KEY\}\} has no value/,
      );
    });

    it('an unsupported algorithm', () => {
      expect(message({ ...ghost, algorithm: 'RS256' })).toMatch(/HS256, HS384 or HS512/);
    });
  });
});

describe('hmacJwtHeader', () => {
  it('renders the header template (Ghost: "Ghost <token>")', () => {
    const header = hmacJwtHeader(
      { jwt: ghost, headerName: 'Authorization', headerTemplate: 'Ghost ${jwt}' },
      NOW,
    );
    expect(header.name).toBe('Authorization');
    expect(header.value).toBe(`Ghost ${signHmacJwt(ghost, NOW)}`);
  });

  it('defaults to Authorization: Bearer <token>', () => {
    const header = hmacJwtHeader({ jwt: ghost }, NOW);
    expect(header).toEqual({ name: 'Authorization', value: `Bearer ${signHmacJwt(ghost, NOW)}` });
  });
});

describe('isHmacJwtSignature', () => {
  it('only for a signature with a jwt block', () => {
    expect(isHmacJwtSignature({ jwt: ghost })).toBe(true);
    expect(isHmacJwtSignature({ secret: 's', template: '${body}' })).toBe(false);
    expect(isHmacJwtSignature(undefined)).toBe(false);
  });
});
