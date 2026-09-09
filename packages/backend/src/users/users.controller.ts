import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, IsOptional, IsEmail, IsEnum, IsBoolean, MinLength, Matches, Equals } from 'class-validator';
import { UserRole } from '../generated/prisma/client';
import { UsersService } from './users.service';
import { AuthService } from '../auth/auth.service';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserLifecycleService, LifecycleContext } from './user-lifecycle.service';

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
    private readonly organizations: OrganizationsService,
    private readonly lifecycle: UserLifecycleService,
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

    // An IdP-provisioned user has no password to confirm with. Refuse rather
    // than hand null to bcrypt — and rather than skip the confirmation, which
    // would make account deletion a one-click action on a stolen session.
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'This account has no password. Account deletion is not available for SSO-only accounts.',
      );
    }

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

    // SSO-only accounts must not be able to grow a password: that would create
    // a second way in that bypasses the IdP's MFA and Conditional Access.
    if (user.passwordLoginDisabled || !user.passwordHash) {
      return {
        error:
          'Password sign-in is disabled for this account. Manage credentials through your organization sign-in.',
      };
    }

    const isValid = await this.authService.comparePassword(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isValid) {
      return { error: 'Current password is incorrect' };
    }

    // Revoke every session issued before now, exactly as the reset flow does.
    // Changing a password is a "lock everyone else out" action; leaving old
    // tokens alive would keep an attacker's session valid for up to 24h (longer
    // on an MCP refresh token) after the user thinks they have shut it down.
    const newHash = await this.authService.hashPassword(dto.newPassword);
    await this.usersService.update(req.user.sub, {
      passwordHash: newHash,
      sessionsValidFrom: new Date(),
    });
    return {
      message:
        'Password changed successfully. Other sessions have been signed out.',
    };
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
      throw new BadRequestException('Cannot change your own role');
    }

    // Writes the MEMBERSHIP role (what authorization reads), refreshes the
    // cache, and revokes sessions on a demotion. The previous implementation
    // wrote only `users.role`, so a demoted admin kept unrestricted MCP
    // tools.
    const result = await this.organizations.updateMemberRole(
      id,
      req.user.organizationId,
      dto.role,
      this.actionContext(req),
    );
    if (!result) throw new NotFoundException('User not found');
    return {
      message: `User role updated to ${dto.role}`,
      sessionsRevoked: result.sessionsRevoked,
    };
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Deactivate a member (ADMIN only): ends their sessions, revokes their MCP keys and removes their access to this workspace. Reversible.',
  })
  async deactivateUser(@Req() req: any, @Param('id') id: string) {
    if (id === req.user.sub) {
      throw new BadRequestException('Cannot deactivate your own account');
    }
    const result = await this.lifecycle.deactivateInOrganization(
      id,
      req.user.organizationId,
      { reason: 'admin', ...this.lifecycleContext(req) },
    );
    switch (result.status) {
      case 'not_a_member':
        throw new NotFoundException('User not found');
      case 'already_inactive':
        return { message: 'User is already deactivated' };
      case 'last_admin_retained':
        // Unreachable for reason 'admin' (the service throws instead), kept
        // so the switch is exhaustive if that policy ever changes.
        return { message: 'Sessions and keys revoked; the last administrator was kept active' };
      default:
        return {
          message: 'User deactivated',
          keysDeactivated: result.keysDeactivated,
        };
    }
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Reactivate a member (ADMIN only). Restores the membership only — revoked MCP keys stay revoked.',
  })
  async reactivateUser(@Req() req: any, @Param('id') id: string) {
    const result = await this.lifecycle.reactivateInOrganization(
      id,
      req.user.organizationId,
      { reason: 'admin', ...this.lifecycleContext(req) },
    );
    if (result.status === 'not_a_member') throw new NotFoundException('User not found');
    if (result.status === 'already_active') return { message: 'User is already active' };
    return { message: 'User reactivated' };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Remove a user from this workspace (ADMIN only). Deletes the account only when this was their sole workspace.',
  })
  async deleteUser(@Req() req: any, @Param('id') id: string) {
    if (id === req.user.sub) {
      throw new BadRequestException('Cannot delete your own account');
    }

    const ok = await this.usersService.deleteInOrg(id, req.user.organizationId, {
      reason: 'admin',
      ...this.lifecycleContext(req),
    });
    if (!ok) throw new NotFoundException('User not found');
    return { message: 'User removed' };
  }

  private actionContext(req: any) {
    return {
      actorUserId: req.user.sub as string,
      ip: req.ip as string | undefined,
      userAgent: req.headers?.['user-agent'] as string | undefined,
    };
  }

  private lifecycleContext(req: any): Omit<LifecycleContext, 'reason'> {
    return {
      actor: { type: 'USER', userId: req.user.sub },
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    };
  }
}
