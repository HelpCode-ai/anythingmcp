import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional } from 'class-validator';
import { OrganizationsService } from './organizations.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '@nestjs/config';

class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  name?: string;
}

class SwitchOrgDto {
  @IsString()
  organizationId: string;
}

class CreateOrgDto {
  @IsString()
  name: string;
}

class DeleteOrgDto {
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
