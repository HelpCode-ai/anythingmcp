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
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsArray } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { RolesService } from './roles.service';

class CreateRoleDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class UpdateRoleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class SetToolAccessDto {
  @IsArray()
  @IsString({ each: true })
  toolIds: string[];
}

class AssignRoleDto {
  @IsOptional()
  @IsString()
  roleId?: string | null;
}

@ApiTags('Roles')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('ADMIN')
@Controller('api/roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({ summary: 'List all roles (ADMIN)' })
  async listRoles(@Req() req: any) {
    return this.rolesService.findAll(req.user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a custom role (ADMIN)' })
  async createRole(@Req() req: any, @Body() dto: CreateRoleDto) {
    return this.rolesService.create({ ...dto, organizationId: req.user.organizationId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get role details with tool access (ADMIN)' })
  async getRole(@Param('id') id: string) {
    const role = await this.rolesService.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a role (ADMIN)' })
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    const role = await this.rolesService.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('Cannot modify system roles');
    return this.rolesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a role (ADMIN)' })
  async deleteRole(@Param('id') id: string) {
    const role = await this.rolesService.findById(id);
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('Cannot delete system roles');
    await this.rolesService.delete(id);
    return { message: 'Role deleted' };
  }

  // ── Tool access ───────────────────────────────────────────────────────────

  @Get(':id/tools')
  @ApiOperation({ summary: 'Get tools assigned to a role (ADMIN)' })
  async getToolAccess(@Param('id') id: string) {
    return this.rolesService.getToolAccess(id);
  }

  @Put(':id/tools')
  @ApiOperation({ summary: 'Set tool access for a role (ADMIN)' })
  async setToolAccess(@Param('id') id: string, @Body() dto: SetToolAccessDto) {
    await this.rolesService.setToolAccess(id, dto.toolIds);
    return { message: 'Tool access updated' };
  }

  // ── User assignment ───────────────────────────────────────────────────────

  @Put('assign/:userId')
  @ApiOperation({ summary: 'Assign MCP role to a user (ADMIN)' })
  async assignRole(@Param('userId') userId: string, @Body() dto: AssignRoleDto) {
    await this.rolesService.assignRoleToUser(userId, dto.roleId ?? null);
    return { message: 'Role assigned' };
  }
}
