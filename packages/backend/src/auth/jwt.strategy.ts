import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, isForeignIssuedToken, isTokenRevoked } from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { getRequiredSecret } from '../common/secrets.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getRequiredSecret(
        'JWT_SECRET',
        configService.get<string>('JWT_SECRET'),
      ),
    });
  }

  async validate(payload: JwtPayload) {
    // SECURITY: the MCP OAuth authorization server signs its access/refresh
    // tokens with the same JWT_SECRET as this strategy, so a valid signature
    // does not imply a dashboard token. Reject anything bearing the MCP-side
    // claims before it can be traded for a dashboard session.
    if (isForeignIssuedToken(payload as unknown as Record<string, unknown>)) {
      throw new UnauthorizedException('Token is not valid for this API');
    }

    // One query: the user row plus their ACTIVE memberships. The membership
    // is the authoritative role and the only proof the user may still act in
    // the organization; `users.role` / `users.organizationId` are caches.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true,
        sessionsValidFrom: true,
        memberships: {
          where: { deactivatedAt: null },
          orderBy: { joinedAt: 'asc' },
          select: { organizationId: true, role: true },
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // Revocation: refuse tokens minted before the user's cutover instant (set
    // on password change, demotion and deactivation). Free to check — the
    // user row is already loaded.
    if (isTokenRevoked(payload, user.sessionsValidFrom)) {
      throw new UnauthorizedException('Session has been revoked');
    }

    const active = user.organizationId
      ? user.memberships.find((m) => m.organizationId === user.organizationId)
      : undefined;

    if (active) {
      // Repair cache drift in place. Rare: only after a role sync wrote the
      // membership, or a pre-fix role change wrote the cache alone.
      if (user.role !== active.role) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { role: active.role },
        });
      }
      return { sub: user.id, email: user.email, role: active.role, organizationId: active.organizationId };
    }

    // The cached org is null, deleted, or the membership in it was deactivated:
    // snap to the oldest remaining ACTIVE membership. Nothing left means the
    // user may not act anywhere — fail closed rather than serve a workspace
    // they were removed from.
    const fallback = user.memberships[0];
    if (!fallback) {
      throw new UnauthorizedException('No active workspace');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { organizationId: fallback.organizationId, role: fallback.role },
    });
    return { sub: user.id, email: user.email, role: fallback.role, organizationId: fallback.organizationId };
  }
}
