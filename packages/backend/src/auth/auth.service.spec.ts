import { JwtService } from '@nestjs/jwt';
import { AuthService, isTokenRevoked } from './auth.service';

describe('AuthService', () => {
  let authService: AuthService;
  let jwtService: JwtService;

  beforeEach(() => {
    jwtService = new JwtService({ secret: 'test-secret' });
    authService = new AuthService(jwtService);
  });

  describe('hashPassword / comparePassword', () => {
    it('should hash a password and verify it', async () => {
      const password = 'MyP@ssw0rd!';
      const hash = await authService.hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash.startsWith('$2')).toBe(true);

      const isValid = await authService.comparePassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject wrong password', async () => {
      const hash = await authService.hashPassword('correct');
      const isValid = await authService.comparePassword('wrong', hash);
      expect(isValid).toBe(false);
    });
  });

  describe('generateToken / verifyToken', () => {
    it('should generate and verify a JWT token', () => {
      const payload = { sub: 'user-1', email: 'a@b.com', role: 'ADMIN', organizationId: 'org-1' };
      const token = authService.generateToken(payload);

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = authService.verifyToken(token);
      expect(decoded.sub).toBe('user-1');
      expect(decoded.email).toBe('a@b.com');
      expect(decoded.role).toBe('ADMIN');
    });

    it('should throw on invalid token', () => {
      expect(() => authService.verifyToken('invalid.token.here')).toThrow(
        'Invalid or expired token',
      );
    });
  });

  describe('isTokenRevoked', () => {
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

    it('accepts everything when the user was never revoked', () => {
      expect(isTokenRevoked({ iat: at('2020-01-01T00:00:00Z') }, null)).toBe(
        false,
      );
      expect(isTokenRevoked({ iat: at('2020-01-01T00:00:00Z') }, undefined)).toBe(
        false,
      );
    });

    it('rejects a token minted before the cutover', () => {
      expect(
        isTokenRevoked(
          { iat: at('2026-05-31T23:59:59Z') },
          new Date('2026-06-01T00:00:00Z'),
        ),
      ).toBe(true);
    });

    it('accepts a token minted after the cutover', () => {
      expect(
        isTokenRevoked(
          { iat: at('2026-06-01T00:00:01Z') },
          new Date('2026-06-01T00:00:00Z'),
        ),
      ).toBe(false);
    });

    it('accepts a token minted in the same second as the cutover', () => {
      // Deliberate: `iat` has second granularity, and the stricter comparison
      // would reject a legitimate token issued moments after a password change.
      expect(
        isTokenRevoked(
          { iat: at('2026-06-01T00:00:00Z') },
          new Date('2026-06-01T00:00:00.400Z'),
        ),
      ).toBe(false);
    });

    it('fails CLOSED on a token with no iat', () => {
      // If the token cannot be dated, a revocation cannot be honoured against
      // it — so it must not be trusted.
      expect(isTokenRevoked({}, new Date('2026-06-01T00:00:00Z'))).toBe(true);
      expect(isTokenRevoked(null, new Date('2026-06-01T00:00:00Z'))).toBe(true);
    });

    it('works on an MCP-issued payload, which carries no marker of ours', () => {
      // The whole reason revocation is a timestamp and not an epoch counter:
      // mcp-nest mints these and would never echo a claim we invented.
      const mcpPayload = { sub: 'u1', type: 'access', azp: 'c1', iat: at('2026-01-01T00:00:00Z') };
      expect(isTokenRevoked(mcpPayload, new Date('2026-06-01T00:00:00Z'))).toBe(
        true,
      );
    });
  });
});
