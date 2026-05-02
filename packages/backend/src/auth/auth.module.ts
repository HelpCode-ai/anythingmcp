import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { LoginController } from './login.controller';
import { JwtStrategy } from './jwt.strategy';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpAuthMiddleware } from './mcp-auth.middleware';
import { McpRateLimitGuard } from './mcp-rate-limit.guard';
import { RolesGuard } from './roles.guard';
import { PrismaOAuthStore } from './prisma-oauth.store';
import { ClientCredentialsMiddleware } from './client-credentials.middleware';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { getRequiredSecret } from '../common/secrets.util';

@Global()
@Module({
  imports: [
    UsersModule,
    SettingsModule,
    McpServersModule,
    OrganizationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: getRequiredSecret(
          'JWT_SECRET',
          configService.get<string>('JWT_SECRET'),
        ),
        signOptions: { expiresIn: '24h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, LoginController],
  providers: [
    AuthService,
    JwtStrategy,
    McpAuthGuard,
    McpAuthMiddleware,
    McpRateLimitGuard,
    RolesGuard,
    PrismaOAuthStore,
    ClientCredentialsMiddleware,
  ],
  exports: [
    AuthService,
    McpAuthGuard,
    McpAuthMiddleware,
    McpRateLimitGuard,
    RolesGuard,
    PrismaOAuthStore,
    ClientCredentialsMiddleware,
    JwtModule,
  ],
})
export class AuthModule {}
