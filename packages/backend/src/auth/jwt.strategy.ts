import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './auth.service';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'default-dev-secret-change-me',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // Self-heal a NULL active org by snapping to the oldest remaining membership.
    // This happens when an organization the user was active in was deleted while
    // they were a member of others — schema's onDelete:SetNull leaves them dangling.
    if (user.organizationId === null) {
      const fallback = await this.prisma.organizationMember.findFirst({
        where: { userId: user.id },
        orderBy: { joinedAt: 'asc' },
      });
      if (fallback) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { organizationId: fallback.organizationId, role: fallback.role },
        });
        return { sub: user.id, email: user.email, role: fallback.role, organizationId: fallback.organizationId };
      }
    }

    return { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId };
  }
}
