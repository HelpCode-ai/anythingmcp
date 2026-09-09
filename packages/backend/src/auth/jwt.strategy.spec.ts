import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../common/prisma.service';

/**
 * Regression guard for the dashboard/MCP token separation.
 *
 * The MCP OAuth authorization server (@rekog/mcp-nest) signs its tokens with
 * the SAME JWT_SECRET as the dashboard API. Anyone can obtain such a token —
 * Dynamic Client Registration is open. If JwtStrategy ever accepts one, an MCP
 * access token becomes a full dashboard session.
 *
 * These tests must keep failing loudly if that separation regresses.
 */
describe('JwtStrategy', () => {
  const SECRET = 'a-test-secret-that-is-at-least-32-chars-long';

  let strategy: JwtStrategy;
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock }; organizationMember: { findFirst: jest.Mock } };

  // The strategy now loads the user WITH their active memberships; the
  // membership is the authoritative role.
  const dbUser = {
    id: 'user-cuid-1',
    email: 'alice@example.com',
    role: 'EDITOR',
    organizationId: 'org-1',
    sessionsValidFrom: null,
    memberships: [{ organizationId: 'org-1', role: 'EDITOR' }],
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(dbUser),
        update: jest.fn(),
      },
      organizationMember: { findFirst: jest.fn() },
    };

    const configService = {
      get: jest.fn().mockReturnValue(SECRET),
    } as unknown as ConfigService;

    strategy = new JwtStrategy(
      configService,
      prisma as unknown as PrismaService,
    );
  });

  describe('dashboard tokens', () => {
    it('accepts a dashboard payload and returns the principal', async () => {
      const result = await strategy.validate({
        sub: 'user-cuid-1',
        email: 'alice@example.com',
        role: 'EDITOR',
        organizationId: 'org-1',
        tokenUse: 'dashboard',
      } as any);

      expect(result).toEqual({
        sub: 'user-cuid-1',
        email: 'alice@example.com',
        role: 'EDITOR',
        organizationId: 'org-1',
      });
    });

    it('still accepts tokens issued before the tokenUse marker existed', async () => {
      // Tokens minted before this change have no `tokenUse` and stay valid for
      // their remaining 24h lifetime. The rejection is driven by the presence
      // of MCP-side claims, not by the absence of the marker.
      const result = await strategy.validate({
        sub: 'user-cuid-1',
        email: 'alice@example.com',
        role: 'EDITOR',
        organizationId: 'org-1',
      } as any);

      expect(result.sub).toBe('user-cuid-1');
    });
  });

  describe('MCP-issued tokens are rejected', () => {
    // Shapes taken verbatim from @rekog/mcp-nest JwtTokenService.generateTokenPair
    // and from ClientCredentialsMiddleware.
    const foreignPayloads: Array<[string, Record<string, unknown>]> = [
      [
        'mcp-nest access token',
        {
          sub: 'user-cuid-1',
          azp: 'client-abc',
          iss: 'https://mcp.example.com',
          aud: 'https://mcp.example.com/mcp',
          resource: 'https://mcp.example.com/mcp',
          type: 'access',
          scope: '',
        },
      ],
      [
        'mcp-nest refresh token',
        {
          sub: 'user-cuid-1',
          client_id: 'client-abc',
          scope: '',
          resource: 'https://mcp.example.com/mcp',
          type: 'refresh',
          jti: 'refresh_deadbeef',
        },
      ],
      [
        'client-credentials token',
        {
          sub: 'client:client-abc',
          azp: 'client-abc',
          scope: '',
          resource: 'https://mcp.example.com/mcp',
          type: 'access',
        },
      ],
      [
        'token carrying an embedded OAuth user profile',
        {
          sub: 'user-cuid-1',
          user_data: { id: 'user-cuid-1', email: 'alice@example.com' },
          user_profile_id: 'profile-1',
        },
      ],
    ];

    it.each(foreignPayloads)('rejects a %s', async (_label, payload) => {
      await expect(strategy.validate(payload as any)).rejects.toThrow(
        'Token is not valid for this API',
      );
    });

    it('rejects before touching the database', async () => {
      // The lookup must never run for a foreign token: a payload whose `sub`
      // is a real user id must not be able to probe or self-heal user records.
      await expect(
        strategy.validate({ sub: 'user-cuid-1', type: 'access' } as any),
      ).rejects.toThrow();

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects even when the MCP sub is the user cuid rather than an email', async () => {
      // This is the case that the pre-existing code got right only by accident:
      // it relied on `findUnique({ id: <an email> })` missing. Normalising the
      // OAuth `sub` to a cuid removes that accident, so the explicit claim
      // check is what has to hold.
      await expect(
        strategy.validate({
          sub: dbUser.id,
          type: 'access',
          azp: 'client-abc',
        } as any),
      ).rejects.toThrow('Token is not valid for this API');

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('unknown users', () => {
    it('rejects when the user no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        strategy.validate({
          sub: 'ghost',
          email: 'g@example.com',
          role: 'EDITOR',
          organizationId: null,
        } as any),
      ).rejects.toThrow('User no longer exists');
    });
  });

  describe('membership is authoritative', () => {
    const dashboard = { sub: 'user-cuid-1', email: 'alice@example.com', tokenUse: 'dashboard' } as any;

    it('returns the MEMBERSHIP role and repairs a stale cache', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...dbUser,
        role: 'ADMIN', // stale cache
        memberships: [{ organizationId: 'org-1', role: 'VIEWER' }],
      });
      const result = await strategy.validate(dashboard);
      expect(result.role).toBe('VIEWER');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-cuid-1' },
        data: { role: 'VIEWER' },
      });
    });

    // A deactivated member must not keep a working session for that workspace.
    it('repoints to another ACTIVE membership when the cached one is deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...dbUser,
        organizationId: 'org-1',
        // org-1 is absent from the active list: deactivated there
        memberships: [{ organizationId: 'org-2', role: 'VIEWER' }],
      });
      const result = await strategy.validate(dashboard);
      expect(result).toMatchObject({ organizationId: 'org-2', role: 'VIEWER' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-cuid-1' },
        data: { organizationId: 'org-2', role: 'VIEWER' },
      });
    });

    it('fails closed when no active membership remains', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...dbUser, memberships: [] });
      await expect(strategy.validate(dashboard)).rejects.toThrow('No active workspace');
    });

    it('only queries ACTIVE memberships', async () => {
      await strategy.validate(dashboard);
      const arg = prisma.user.findUnique.mock.calls[0][0];
      expect(arg.select.memberships.where).toEqual({ deactivatedAt: null });
    });
  });
});
