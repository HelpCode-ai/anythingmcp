import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { OrganizationsService } from './organizations.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';

class UpdateOrganizationDto {
  @ApiPropertyOptional({ description: 'New organization name.' })
  @IsOptional()
  @IsString()
  name?: string;
}

class SwitchOrgDto {
  @ApiProperty({ description: 'Organization id to switch the caller\'s session to.' })
  @IsString()
  organizationId: string;
}

class CreateOrgDto {
  @ApiProperty({ description: 'Display name for the new organization.', example: 'Acme Inc.' })
  @IsString()
  name: string;
}

class RevokeWorkspaceSessionsDto {
  @ApiProperty({
    description:
      'Type the organization name exactly to confirm — this signs every member out of every client.',
  })
  @IsString()
  confirmName: string;

  @ApiPropertyOptional({
    description:
      'Leave your own sessions alone. Off by default: if the compromised session is yours, excluding it defeats the point.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  excludeSelf?: boolean;

  @ApiPropertyOptional({
    description:
      'Also deactivate every MCP API key in this workspace. Off by default: API keys are not sessions and are never touched by a plain revocation.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  revokeApiKeys?: boolean;
}

class DeleteOrgDto {
  @ApiProperty({
    description:
      'Type the organization name exactly to confirm deletion — protection against accidental calls.',
  })
  @IsString()
  confirmName: string;
}

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get('mine')
  @ApiOperation({ summary: 'List organizations the current user belongs to' })
  async listMine(@Req() req: any) {
    return this.organizationsService.listUserOrgs(req.user.sub);
  }

  @Get('current')
  @ApiOperation({ summary: 'Get current active organization' })
  async getCurrent(@Req() req: any) {
    if (!req.user.organizationId) {
      throw new NotFoundException('No active organization');
    }
    const org = await this.organizationsService.findById(req.user.organizationId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  @Put('current')
  @ApiOperation({ summary: 'Update current organization (ADMIN only)' })
  async updateCurrent(@Req() req: any, @Body() dto: UpdateOrganizationDto) {
    if (req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can update the organization');
    }
    return this.organizationsService.update(req.user.organizationId, dto);
  }

  @Delete('current')
  @ApiOperation({ summary: 'Delete current organization (ADMIN only)' })
  async deleteCurrent(@Req() req: any, @Body() dto: DeleteOrgDto) {
    if (req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can delete the organization');
    }
    if (!req.user.organizationId) {
      throw new BadRequestException('No active organization');
    }

    const { activeUser, activeOrganization, autoCreated } =
      await this.organizationsService.deleteOrganization(
        req.user.sub,
        req.user.organizationId,
        dto.confirmName,
      );

    const accessToken = this.authService.generateToken({
      sub: activeUser.id,
      email: activeUser.email,
      role: activeUser.role,
      organizationId: activeUser.organizationId,
      mcpRoleId: activeUser.mcpRoleId,
    });

    return {
      message: 'Organization deleted',
      accessToken,
      user: {
        id: activeUser.id,
        email: activeUser.email,
        name: activeUser.name,
        role: activeUser.role,
        organizationId: activeUser.organizationId,
      },
      organization: activeOrganization,
      autoCreated,
    };
  }

  @Post('current/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Force every member of the current organization to sign in again (ADMIN only). Invalidates dashboard sessions and AI-client connections, including ones holding a refresh token. MCP API keys are unaffected unless revokeApiKeys is set. Members who also belong to other workspaces are signed out there too (the watermark is per user).',
  })
  async revokeWorkspaceSessions(@Req() req: any, @Body() dto: RevokeWorkspaceSessionsDto) {
    if (req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can revoke workspace sessions');
    }
    if (!req.user.organizationId) {
      throw new BadRequestException('No active organization');
    }
    const org = await this.organizationsService.findById(req.user.organizationId);
    if (!org) throw new NotFoundException('Organization not found');
    if (dto.confirmName.trim() !== org.name.trim()) {
      throw new BadRequestException('Organization name does not match');
    }

    const result = await this.organizationsService.revokeWorkspaceSessions(
      req.user.organizationId,
      { excludeSelf: dto.excludeSelf === true, revokeApiKeys: dto.revokeApiKeys === true },
      {
        actorUserId: req.user.sub,
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
      },
    );
    return {
      message: dto.excludeSelf
        ? 'Every other member must sign in again.'
        : 'Every member, including you, must sign in again.',
      selfIncluded: dto.excludeSelf !== true,
      ...result,
    };
  }

  @Post('switch')
  @ApiOperation({ summary: 'Switch active organization' })
  async switchOrg(@Req() req: any, @Body() dto: SwitchOrgDto) {
    const user = await this.organizationsService.switchOrg(req.user.sub, dto.organizationId);
    const org = await this.organizationsService.findById(dto.organizationId);

    // Issue a new JWT with the updated organizationId and role
    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      mcpRoleId: user.mcpRoleId,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
      organization: org,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new organization (cloud mode)' })
  async createOrg(@Req() req: any, @Body() dto: CreateOrgDto) {
    const org = await this.organizationsService.create(dto.name);
    // Add creator as ADMIN member
    await this.organizationsService.addMember(req.user.sub, org.id, 'ADMIN' as any);
    return org;
  }
}
