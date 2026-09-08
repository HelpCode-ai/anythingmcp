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
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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
import { RecoveryCodesService } from '../auth/recovery-codes.service';

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

  @ApiPropertyOptional({
    type: [String],
    description:
      'MCP roles granted when the fallback is DEFAULT_ROLE and nothing matched. Empty makes DEFAULT_ROLE behave like DENY_ALL.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleSyncDefaultRoleIds?: string[];
}

class RoleMappingDto {
  @ApiProperty({
    description:
      "The Entra group's OBJECT ID or the app role's `value` — never its display name. Microsoft does not make group names unique, so matching on one would let anyone able to create a group mint one named like a privileged mapping.",
  })
  @IsString()
  externalId: string;

  @ApiPropertyOptional({
    description: 'Human-readable name, shown in the admin table. Carries no authorization meaning.',
  })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    enum: ['VIEWER', 'EDITOR', 'ADMIN'],
    description: 'Workspace role granted. Omit to leave it untouched. Across several matching groups the MOST privileged wins.',
  })
  @IsOptional()
  @IsIn(['VIEWER', 'EDITOR', 'ADMIN'])
  userRole?: 'VIEWER' | 'EDITOR' | 'ADMIN';

  @ApiPropertyOptional({ type: [String], description: 'MCP roles granted. A user in several mapped groups receives the UNION.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpRoleIds?: string[];
}

class EnforceSsoDto {
  @ApiProperty({
    description:
      'Turn password sign-in off for this workspace. Enabling requires a completed sign-in through this provider and unused recovery codes on the calling account.',
  })
  @IsBoolean()
  enforce: boolean;
}

class ReplaceRoleMappingsDto {
  @ApiProperty({ type: [RoleMappingDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleMappingDto)
  mappings: RoleMappingDto[];
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
    private readonly recoveryCodes: RecoveryCodesService,
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
      // The key must avoid EVERY word in SecurityEventService's redaction
      // pattern, which matches the KEY, not the value. Both `secretRotated`
      // and `credentialRotated` hit it ("secret" and "credential" are both
      // listed) and persisted as the string "[REDACTED]" instead of a boolean,
      // silently losing the record of whether an admin rotated the credential.
      rotated: Boolean(dto.clientSecret),
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

  @Get(':id/role-mappings')
  @ApiOperation({ summary: 'List this provider\'s group/app-role mappings (ADMIN)' })
  async listRoleMappings(@Req() req: any, @Param('id') id: string) {
    const mappings = await this.service.listRoleMappings(
      id,
      req.user.organizationId,
    );
    if (mappings === null) throw new NotFoundException('Identity provider not found');
    return mappings;
  }

  @Put(':id/role-mappings')
  @ApiOperation({
    summary: 'Replace this provider\'s group/app-role mappings (ADMIN)',
  })
  async replaceRoleMappings(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ReplaceRoleMappingsDto,
  ) {
    const before = await this.service.listRoleMappings(
      id,
      req.user.organizationId,
    );
    if (before === null) throw new NotFoundException('Identity provider not found');

    const after = await this.run(() =>
      this.service.replaceRoleMappings(id, req.user.organizationId, dto.mappings),
    );

    // Before AND after: this table decides who gets which tools, so an event
    // saying only what the rules became cannot answer "what did this change?"
    await this.audit(req, SecurityEvents.IDP_ROLE_MAPPING_CHANGED, id, {
      before: before.map(summariseMapping),
      after: (after ?? []).map(summariseMapping),
    });
    return after;
  }

  @Put(':id/enforce-sso')
  @ApiOperation({
    summary: 'Require single sign-on for this workspace (ADMIN)',
  })
  async setEnforceSso(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: EnforceSsoDto,
  ) {
    const hasRecoveryCodes = await this.recoveryCodes.hasUnused(req.user.sub);
    const updated = await this.run(() =>
      this.service.setEnforceSso(id, req.user.organizationId, dto.enforce, {
        userId: req.user.sub,
        hasRecoveryCodes,
      }),
    );
    if (!updated) throw new NotFoundException('Identity provider not found');

    await this.audit(req, SecurityEvents.SSO_ENFORCEMENT_CHANGED, id, {
      enforce: dto.enforce,
    });
    return updated;
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

/** Audit projection: the fields that decide access, without the row id. */
function summariseMapping(m: {
  externalId: string;
  label: string | null;
  userRole: string | null;
  mcpRoleIds: string[];
}) {
  return {
    externalId: m.externalId,
    label: m.label,
    userRole: m.userRole,
    // Joined, not an array: `metadata → after[] → {} → mcpRoleIds[] → string`
    // is five levels, one past the redactor's depth bound, and the ids came
    // out as a truncation marker — the audit recorded that mappings changed
    // but not what they changed to, which is the only part worth having.
    mcpRoleIds: [...m.mcpRoleIds].sort().join(','),
  };
}
