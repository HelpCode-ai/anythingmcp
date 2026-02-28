import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpAuthMiddleware } from './mcp-auth.middleware';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { RolesGuard } from './roles.guard';
import { UsersModule } from '../users/users.module';

@Global()
@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '24h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, McpAuthGuard, McpAuthMiddleware, McpRateLimitGuard, RolesGuard],
  exports: [AuthService, McpAuthGuard, McpAuthMiddleware, McpRateLimitGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
