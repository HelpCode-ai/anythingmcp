import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';

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
      const payload = { sub: 'user-1', email: 'a@b.com', role: 'ADMIN' };
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
});
