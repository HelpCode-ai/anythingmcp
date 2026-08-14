import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsObject,
  IsISO8601,
} from 'class-validator';
import { IdentityProviderType } from '../generated/prisma/client';
import { Roles, RolesGuard } from '../auth/roles.guard';
import {
  IdentityProvidersService,
  IdentityProviderError,
} from './identity-providers.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';

// Derived from the Prisma enum rather than hand-kept: a new provider type is
// then accepted automatically and cannot drift out of sync with the database.
const PROVIDER_TYPES = Object.values(IdentityProviderType);

class UpsertProviderDto {
  @ApiProperty({ enum: PROVIDER_TYPES, description: 'Identity provider type. Immutable after creation.' })
  @IsIn(PROVIDER_TYPES)
  type: IdentityProviderType;

  @ApiProperty({ description: 'Label shown on the sign-in button.' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'OAuth client id from the provider.' })
  @IsString()
  clientId: string;

  @ApiPropertyOptional({
    description:
      'Client secret. Required on create. Omit on update to keep the stored one — the API never returns it.',
  })
  @IsOptional()
  @IsString()
  clientSecret?: string;

  @ApiPropertyOptional({ description: 'When the client secret expires, for the renewal reminder.' })
  @IsOptional()
  // `strict` rejects the compact and week-date forms validator.js otherwise
  // accepts ("20260101", "2026-W01-1"), which reach `new Date()` as Invalid
  // Date and then Prisma as a 500. `strictSeparator` pins the T.
  @IsISO8601({ strict: true, strictSeparator: true })
  clientSecretExpiresAt?: string | null;

  @ApiPropertyOptional({
    description:
      'Issuer URL. Only for OKTA, AUTH0 and OIDC; derived automatically for the others.',
  })
  @IsOptional()
  @IsString()
  issuer?: string;

  @ApiPropertyOptional({
    description:
      'Type-specific settings. ENTRA: { tenantId }. GOOGLE: { hostedDomain }. OKTA: { authorizationServerId }. AUTH0: { rolesClaimNamespace }. GITHUB: { organization }. OIDC: { groupsClaimName }.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Create an account on first sign-in. Off by default: with it on, everyone in the external tenant can enter this workspace.',
  })
  @IsOptional()
  @IsBoolean()
  jitProvisioning?: boolean;

  @ApiPropertyOptional({ description: 'Only VIEWER is accepted.' })
  @IsOptional()
  @IsIn(['VIEWER'])
  jitDefaultRole?: 'VIEWER';

  @ApiPropertyOptional() @IsOptional() @IsBoolean() roleSyncEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['APP_ROLES', 'GROUPS'] })
  @IsOptional()
  @IsIn(['APP_ROLES', 'GROUPS'])
  roleSyncSource?: 'APP_ROLES' | 'GROUPS';

  @ApiPropertyOptional({
    enum: ['DENY_ALL', 'KEEP_EXISTING', 'DEFAULT_ROLE'],
    description:
      'What to do when no mapping matches. DENY_ALL by default, because the alternatives fail open: a user holding NO MCP role is unrestricted, so granting nothing is safer than granting a default.',
  })
  @IsOptional()
  @IsIn(['DENY_ALL', 'KEEP_EXISTING', 'DEFAULT_ROLE'])
  roleSyncFallback?: 'DENY_ALL' | 'KEEP_EXISTING' | 'DEFAULT_ROLE';
}

/**
 * Identity provider configuration.
 *
 * Every route is scoped by `req.user.organizationId`, like the SMTP settings —
 * and deliberately NOT like `PUT /api/admin/settings/ssrf-allowed-hosts`, which
 * lets any workspace admin edit an instance-wide list. There is no service-admin
 * role in this product, so `@Roles('ADMIN')` means "admin of one workspace" and
 * nothing here may reach beyond it.
 */
@ApiTags('Identity Providers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/identity-providers')
export class IdentityProvidersController {
  constructor(
    private readonly service: IdentityProvidersService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List identity providers for this workspace (ADMIN)' })
  async list(@Req() req: any) {
    return this.service.findAll(req.user.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one identity provider (ADMIN)' })
  async get(@Req() req: any, @Param('id') id: string) {
    const provider = await this.service.findByIdForOrg(
      id,
      req.user.organizationId,
    );
    if (!provider) throw new NotFoundException('Identity provider not found');
    return provider;
  }

  @Post()
  @ApiOperation({ summary: 'Create an identity provider (ADMIN)' })
  async create(@Req() req: any, @Body() dto: UpsertProviderDto) {
    const created = await this.run(() =>
      this.service.create(req.user.organizationId, dto),
    );
    await this.audit(req, SecurityEvents.IDP_CREATED, created.id, {
      type: dto.type,
      name: dto.name,
      issuer: created.issuer,
      jitProvisioning: created.jitProvisioning,
    });
    return created;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an identity provider (ADMIN)' })
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpsertProviderDto,
  ) {
    const before = await this.service.findByIdForOrg(
      id,
      req.user.organizationId,
    );
    if (!before) throw new NotFoundException('Identity provider not found');

    const updated = await this.run(() =>
      this.service.update(id, req.user.organizationId, dto),
    );
    if (!updated) throw new NotFoundException('Identity provider not found');

    // Diff of the trust anchor. The secret is never included — not even a
    // prefix — and SecurityEventService redacts it again on the way in.
    await this.audit(req, SecurityEvents.IDP_UPDATED, id, {
      type: updated.type,
      // `config` is diffed too: for GOOGLE, GITHUB and OIDC the issuer is a
      // constant, so the real restriction on who may sign in (hostedDomain,
      // organization, groupsClaimName) lives there. Without it a change that
      // widens access would produce an event whose before/after are identical.
      before: {
        issuer: before.issuer,
        clientId: before.clientId,
        config: before.config,
        jitProvisioning: before.jitProvisioning,
        roleSyncEnabled: before.roleSyncEnabled,
        isActive: before.isActive,
      },
      after: {
        issuer: updated.issuer,
        clientId: updated.clientId,
        config: updated.config,
        jitProvisioning: updated.jitProvisioning,
        roleSyncEnabled: updated.roleSyncEnabled,
        isActive: updated.isActive,
      },
      // NOT named `*secret*`: SecurityEventService.redact matches the KEY
      // against /secret/i, so `secretRotated` would persist as the string
      // "[REDACTED]" instead of a boolean — the signal would never arrive.
      credentialRotated: Boolean(dto.clientSecret),
    });

    if (dto.clientSecret) {
      await this.audit(req, SecurityEvents.IDP_SECRET_ROTATED, id, {
        expiresAt: updated.clientSecretExpiresAt,
      });
    }
    return updated;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an identity provider (ADMIN)' })
  async remove(@Req() req: any, @Param('id') id: string) {
    // Read it first: deleting a workspace's whole SSO trust anchor must leave
    // a record of WHAT was removed, not just that something was.
    const before = await this.service.findByIdForOrg(
      id,
      req.user.organizationId,
    );
    const deleted = await this.service.delete(id, req.user.organizationId);
    if (!deleted) throw new NotFoundException('Identity provider not found');
    await this.audit(req, SecurityEvents.IDP_DELETED, id, {
      type: before?.type,
      name: before?.name,
      issuer: before?.issuer,
      clientId: before?.clientId,
    });
    return { message: 'Identity provider deleted' };
  }

  @Post(':id/test')
  @ApiOperation({
    summary:
      'Fetch the provider discovery document and verify the issuer matches (ADMIN)',
  })
  async test(@Req() req: any, @Param('id') id: string) {
    return this.service.testConnection(id, req.user.organizationId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Turns configuration and constraint errors into 4xx rather than 500s. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (error instanceof IdentityProviderError) {
        throw new BadRequestException(error.message);
      }
      // A duplicate name hits @@unique([organizationId, name]). Without this it
      // surfaces as a 500 with the whole Prisma error in the logs.
      if (error?.code === 'P2002') {
        throw new ConflictException(
          'An identity provider with this name already exists in this workspace',
        );
      }
      throw error;
    }
  }

  private async audit(
    req: any,
    event: string,
    providerId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.securityEvents.log({
      event,
      actorType: 'USER',
      organizationId: req.user.organizationId,
      actorUserId: req.user.sub,
      metadata: { providerId, ...metadata },
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }
}
