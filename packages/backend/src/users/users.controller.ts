import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsEmail, IsEnum, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { AuthService } from '../auth/auth.service';
import { Roles, RolesGuard } from '../auth/roles.guard';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

class ChangePasswordDto {
  @IsString()
  @MinLength(8)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

class UpdateAiConfigDto {
  @IsString()
  provider: string;

  @IsString()
  apiKey: string;
}

class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role: UserRole;
}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Req() req: any) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user) return { error: 'User not found' };
    const { passwordHash, aiApiKey, ...profile } = user;
    return profile;
  }

  @Put('me')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.email) data.email = dto.email;

    const user = await this.usersService.update(req.user.sub, data);
    const { passwordHash, aiApiKey, ...profile } = user;
    return profile;
  }

  @Put('me/password')
  @ApiOperation({ summary: 'Change password' })
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user) return { error: 'User not found' };

    const isValid = await this.authService.comparePassword(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isValid) {
      return { error: 'Current password is incorrect' };
    }

    const newHash = await this.authService.hashPassword(dto.newPassword);
    await this.usersService.update(req.user.sub, { passwordHash: newHash });
    return { message: 'Password changed successfully' };
  }

  @Put('me/ai-config')
  @ApiOperation({ summary: 'Update AI provider configuration' })
  async updateAiConfig(@Req() req: any, @Body() dto: UpdateAiConfigDto) {
    await this.usersService.updateAiConfig(
      req.user.sub,
      dto.provider,
      dto.apiKey,
    );
    return { message: 'AI configuration updated' };
  }

  // ── Admin endpoints ──────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List all users (ADMIN only)' })
  async listUsers() {
    return this.usersService.findAll();
  }

  @Put(':id/role')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update user role (ADMIN only)' })
  async updateRole(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    if (id === req.user.sub) {
      return { error: 'Cannot change your own role' };
    }

    const user = await this.usersService.findById(id);
    if (!user) return { error: 'User not found' };

    await this.usersService.update(id, { role: dto.role });
    return { message: `User role updated to ${dto.role}` };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a user (ADMIN only)' })
  async deleteUser(@Req() req: any, @Param('id') id: string) {
    if (id === req.user.sub) {
      return { error: 'Cannot delete your own account' };
    }

    await this.usersService.delete(id);
    return { message: 'User deleted' };
  }
}
