import {
  Controller,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsEmail, IsEnum, IsBoolean, MinLength, Matches, Equals } from 'class-validator';
import { UserRole } from '../generated/prisma/client';
import { UsersService } from './users.service';
import { AuthService } from '../auth/auth.service';
import { Roles, RolesGuard } from '../auth/roles.guard';

class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Display name.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Email. Triggers re-verification on change.' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character';

class ChangePasswordDto {
  @ApiProperty({ description: 'Current password (verified before applying the change).', format: 'password' })
  @IsString()
  @MinLength(8)
  currentPassword: string;

  @ApiProperty({ description: 'New password (8+ chars, mixed case, digit, special).', format: 'password' })
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

class UpdateOnboardingStateDto {
  @ApiPropertyOptional({
    description:
      'Mark onboarding as completed (sets onboardingCompletedAt = now). ' +
      'Frontend calls this when the user finishes or explicitly skips the welcome wizard.',
  })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({
    description: 'Hard unsubscribe from drip emails. Transactional mail keeps flowing.',
  })
  @IsOptional()
  @IsBoolean()
  emailMarketingOptOut?: boolean;
}

class UpdateUserRoleDto {
  @ApiProperty({ enum: UserRole, description: 'New organization role for the target user.' })
  @IsEnum(UserRole)
  role: UserRole;
}

class DeleteSelfDto {
  @ApiProperty({ description: 'Account password (re-confirmation).', format: 'password' })
  @IsString()
  @MinLength(1)
  password: string;

  @ApiProperty({
    description: 'Must equal the literal string "DELETE" — protection against accidental calls.',
    example: 'DELETE',
  })
  @IsString()
  @Equals('DELETE')
  confirm: string;
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
    const { passwordHash, ...profile } = user;
    return profile;
  }

  @Get('me/onboarding-state')
  @ApiOperation({
    summary: 'Get onboarding/wizard state for the current user',
    description:
      'Returns the fields used by the welcome wizard and the drip cron. ' +
      'The frontend combines this with /api/license/status and /api/connectors ' +
      'to decide whether to redirect to /welcome.',
  })
  async getOnboardingState(@Req() req: any) {
    return this.usersService.getOnboardingState(req.user.sub);
  }

  @Patch('me/onboarding-state')
  @ApiOperation({
    summary: 'Update onboarding state (skip/finish the wizard, opt out of marketing emails)',
  })
  async updateOnboardingState(
    @Req() req: any,
    @Body() dto: UpdateOnboardingStateDto,
  ) {
    return this.usersService.updateOnboardingState(req.user.sub, dto);
  }

  @Put('me')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.email) data.email = dto.email;

    const user = await this.usersService.update(req.user.sub, data);
    const { passwordHash, ...profile } = user;
    return profile;
  }

  @Delete('me')
  @ApiOperation({ summary: 'Delete current user account (self-delete)' })
  async deleteSelf(@Req() req: any, @Body() dto: DeleteSelfDto) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user) throw new UnauthorizedException('User not found');

    const isValid = await this.authService.comparePassword(dto.password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid password');

    await this.usersService.deleteSelf(req.user.sub);
    return { message: 'Account deleted' };
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

  // ── Admin endpoints ──────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List all users in organization (ADMIN only)' })
  async listUsers(@Req() req: any) {
    return this.usersService.findAll(req.user.organizationId);
  }

  @Get('invitations')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List pending/expired invitations (ADMIN only)' })
  async listInvitations(@Req() req: any) {
    return this.usersService.findAllInvitations(req.user.organizationId);
  }

  @Delete('invitations/:id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Revoke an invitation (ADMIN only)' })
  async deleteInvitation(@Req() req: any, @Param('id') id: string) {
    const ok = await this.usersService.deleteInvitationInOrg(id, req.user.organizationId);
    if (!ok) return { error: 'Invitation not found' };
    return { message: 'Invitation revoked' };
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

    const updated = await this.usersService.updateInOrg(
      id,
      req.user.organizationId,
      { role: dto.role },
    );
    if (!updated) return { error: 'User not found' };
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

    const ok = await this.usersService.deleteInOrg(id, req.user.organizationId);
    if (!ok) return { error: 'User not found' };
    return { message: 'User deleted' };
  }
}
