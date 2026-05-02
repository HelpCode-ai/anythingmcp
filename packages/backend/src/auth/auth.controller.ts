import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength, IsOptional, IsEnum, IsBoolean, Equals, Matches } from 'class-validator';
import { UserRole } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from '../settings/email.service';
import { SiteSettingsService } from '../settings/site-settings.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { Roles, RolesGuard } from './roles.guard';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character';

class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;

  @IsString()
  name: string;

  @IsBoolean()
  @Equals(true, { message: 'You must accept the Terms of Use' })
  acceptTerms: boolean;
}

class VerifyEmailDto {
  @IsString()
  code: string;
}

class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

class InviteUserDto {
  @IsEmail()
  email: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsString()
  mcpRoleId?: string;
}

class AcceptInviteDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;

  @IsString()
  name: string;
}

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly mcpServersService: McpServersService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly siteSettings: SiteSettingsService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  private getFrontendUrl(req?: any): string {
    // Derive from the incoming request so links match the domain the user is on,
    // even when FRONTEND_URL env var is stale or misconfigured.
    if (req?.headers) {
      const origin = req.headers['origin'];
      if (origin) return origin.replace(/\/+$/, '');

      const referer = req.headers['referer'];
      if (referer) {
        try {
          const url = new URL(referer);
          return url.origin;
        } catch {}
      }
    }

    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    );
  }

  private async createAndSendVerificationCode(userId: string, email: string, req?: any): Promise<boolean> {
    // Invalidate old tokens
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generate 6-digit code + UUID link token
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const linkToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await this.prisma.emailVerificationToken.create({
      data: { userId, token: linkToken, code, expiresAt },
    });

    // Build verification link URL — route through anythingmcp.com so the
    // link domain matches the Resend sending domain (avoids spam filters).
    const instanceUrl = this.getFrontendUrl(req);
    const verifyUrl = `https://anythingmcp.com/verify-email?token=${linkToken}&instance=${encodeURIComponent(instanceUrl)}`;

    // Send email
    try {
      return await this.emailService.sendVerificationEmail(email, code, verifyUrl);
    } catch (err) {
      this.logger.error(`Failed to send verification email to ${email}: ${err}`);
      return false;
    }
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ 'auth-strict': { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Req() req: any, @Body() dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await this.authService.comparePassword(
      dto.password,
      user.passwordHash,
    );
    if (!isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      mcpRoleId: user.mcpRoleId,
    });

    // If user hasn't verified email, resend a verification code
    if (!user.emailVerified) {
      await this.createAndSendVerificationCode(user.id, user.email, req);
    }

    // Check if ADMIN needs to complete license setup
    let needsLicenseSetup = false;
    if (user.role === 'ADMIN') {
      const licenseKey = await this.siteSettings.get('license_key');
      if (!licenseKey) {
        needsLicenseSetup = true;
      }
    }

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
        emailVerified: user.emailVerified,
      },
      ...(needsLicenseSetup && { needsLicenseSetup: true }),
    };
  }

  @Post('register')
  @Throttle({ 'auth-strict': { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new user account' })
  async register(@Req() req: any, @Body() dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const userCount = await this.usersService.count();
    const isCloud = this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';

    // In cloud mode: every self-registered user is ADMIN of their own org
    // In self-hosted: first user is ADMIN, others are EDITOR
    const role = (isCloud || userCount === 0) ? 'ADMIN' : 'EDITOR';

    if (userCount > 0 && this.configService.get<string>('ALLOW_OPEN_REGISTRATION') !== 'true') {
      throw new ForbiddenException(
        'Registration is disabled. Please contact an administrator for an invitation.',
      );
    }
    let organizationId: string;

    if (!isCloud && userCount > 0) {
      // Self-hosted: join the existing (first) organization
      const existingOrg = await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
      organizationId = existingOrg!.id;
    } else {
      // Cloud or first user: create a new organization
      const orgName = `${dto.name || dto.email.split('@')[0]}'s Workspace`;
      const org = await this.organizationsService.create(orgName);
      organizationId = org.id;
    }

    const passwordHash = await this.authService.hashPassword(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      role: role as any,
      organizationId,
    });

    // Create organization membership
    await this.organizationsService.addMember(user.id, organizationId, role as any);

    // Create default MCP server for new user
    await this.mcpServersService.createDefaultForUser(user.id, organizationId);

    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId,
      mcpRoleId: user.mcpRoleId,
    });

    // Send verification email
    await this.createAndSendVerificationCode(user.id, user.email, req);

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId,
        emailVerified: false,
      },
      isFirstUser: role === 'ADMIN',
    };
  }

  // ── Email Verification ───────────────────────────────────────────────────────

  @Post('verify-email')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with 6-digit code' })
  async verifyEmail(@Req() req: any, @Body() dto: VerifyEmailDto) {
    const userId = req.user.sub;

    const record = await this.prisma.emailVerificationToken.findFirst({
      where: {
        userId,
        code: dto.code,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    // Mark token as used
    await this.prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    // Mark user as verified
    await this.usersService.update(userId, { emailVerified: true });

    return { message: 'Email verified successfully', emailVerified: true };
  }

  @Get('verify-email-link')
  @ApiOperation({ summary: 'Verify email via link token' })
  async verifyEmailLink(@Req() req: any, @Query('token') token: string, @Res() res: Response) {
    if (!token) throw new BadRequestException('Token is required');

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { token },
    });

    if (!record) throw new BadRequestException('Invalid verification token');
    if (record.usedAt) throw new BadRequestException('This link has already been used');
    if (record.expiresAt < new Date()) throw new BadRequestException('This link has expired');

    // Mark as used and verify user
    await this.prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await this.usersService.update(record.userId, { emailVerified: true });

    // Redirect to frontend
    const frontendUrl = this.getFrontendUrl(req);
    return res.redirect(`${frontendUrl}/login?emailVerified=true`);
  }

  @Post('resend-verification')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Throttle({ 'auth': { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend email verification code' })
  async resendVerification(@Req() req: any) {
    const userId = req.user.sub;
    const user = await this.usersService.findById(userId);

    if (!user) throw new BadRequestException('User not found');
    if (user.emailVerified) {
      return { message: 'Email is already verified' };
    }

    // Rate limit: max 5 tokens in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await this.prisma.emailVerificationToken.count({
      where: { userId, createdAt: { gt: oneHourAgo } },
    });
    if (recentCount >= 5) {
      throw new BadRequestException('Too many verification attempts. Please try again later.');
    }

    const sent = await this.createAndSendVerificationCode(userId, user.email, req);

    if (!sent) {
      throw new BadRequestException('Failed to send verification email. SMTP may not be configured.');
    }

    return { message: 'Verification code resent' };
  }

  // ── Invitation Flow ─────────────────────────────────────────────────────────

  @Post('invite')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invite a user to the workspace (ADMIN only)' })
  async inviteUser(@Req() req: any, @Body() dto: InviteUserDto) {
    // Check if user already exists in THIS organization
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      const membership = await this.organizationsService.getMembership(existing.id, req.user.organizationId);
      if (membership) {
        throw new ConflictException('This user is already a member of your organization');
      }
      // User exists but not in this org — allow invitation for multi-org membership
    }

    // Check for existing pending invitation to this org
    const existingInvite = await this.prisma.invitationToken.findFirst({
      where: {
        email: dto.email,
        organizationId: req.user.organizationId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (existingInvite) {
      throw new ConflictException('An active invitation already exists for this email');
    }

    // Generate invitation token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    await this.prisma.invitationToken.create({
      data: {
        email: dto.email,
        token: inviteToken,
        role: dto.role,
        mcpRoleId: dto.mcpRoleId || null,
        invitedBy: req.user.sub,
        organizationId: req.user.organizationId,
        expiresAt,
      },
    });

    // Build invitation URL — route through anythingmcp.com so the
    // link domain matches the Resend sending domain (avoids spam filters).
    const instanceUrl = this.getFrontendUrl(req);
    const inviteUrl = `https://anythingmcp.com/accept-invite?token=${inviteToken}&instance=${encodeURIComponent(instanceUrl)}`;

    // Get inviter's name for the email
    const inviter = await this.usersService.findById(req.user.sub);
    const inviterName = inviter?.name || inviter?.email || 'An administrator';

    // Build role label
    let roleName: string = dto.role;
    if (dto.mcpRoleId) {
      const mcpRole = await this.prisma.role.findUnique({ where: { id: dto.mcpRoleId } });
      if (mcpRole) roleName = `${dto.role} (MCP: ${mcpRole.name})`;
    }

    // Send email
    const emailResult = await this.emailService.sendInvitationEmail(
      dto.email,
      inviteUrl,
      inviterName,
      roleName,
    );

    return {
      message: emailResult.sent
        ? `Invitation sent to ${dto.email}`
        : `Invitation created for ${dto.email}, but the email could not be sent. Share the link manually.`,
      inviteUrl,
      emailSent: emailResult.sent,
      ...(emailResult.error ? { emailError: emailResult.error } : {}),
    };
  }

  @Get('invite/verify')
  @ApiOperation({ summary: 'Verify an invitation token' })
  async verifyInvite(@Query('token') token: string) {
    if (!token) throw new BadRequestException('Token is required');

    const invite = await this.prisma.invitationToken.findUnique({
      where: { token },
    });

    if (!invite) throw new BadRequestException('Invalid invitation token');
    if (invite.usedAt) throw new BadRequestException('This invitation has already been used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('This invitation has expired');

    return {
      email: invite.email,
      role: invite.role,
      valid: true,
    };
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept an invitation and create account' })
  async acceptInvite(@Body() dto: AcceptInviteDto) {
    const invite = await this.prisma.invitationToken.findUnique({
      where: { token: dto.token },
    });

    if (!invite) throw new BadRequestException('Invalid invitation token');
    if (invite.usedAt) throw new BadRequestException('This invitation has already been used');
    if (invite.expiresAt < new Date()) throw new BadRequestException('This invitation has expired');

    // Check if email already registered
    const existing = await this.usersService.findByEmail(invite.email);

    let user: any;
    if (existing) {
      // Existing user — add to the new organization (multi-org)
      const alreadyMember = await this.organizationsService.getMembership(existing.id, invite.organizationId);
      if (alreadyMember) {
        throw new ConflictException('You are already a member of this organization');
      }
      await this.organizationsService.addMember(existing.id, invite.organizationId, invite.role);
      // Switch their active org to the newly joined one
      user = await this.organizationsService.switchOrg(existing.id, invite.organizationId);
    } else {
      // New user — create account and join the organization
      const passwordHash = await this.authService.hashPassword(dto.password);
      user = await this.usersService.create({
        email: invite.email,
        passwordHash,
        name: dto.name,
        role: invite.role,
        organizationId: invite.organizationId,
      });

      // Create organization membership
      await this.organizationsService.addMember(user.id, invite.organizationId, invite.role);

      // Mark email as verified (invited users don't need to verify)
      await this.usersService.update(user.id, { emailVerified: true });

      // Create default MCP server for new user
      await this.mcpServersService.createDefaultForUser(user.id, invite.organizationId);

      // Assign MCP role if specified
      if (invite.mcpRoleId) {
        await this.usersService.update(user.id, { mcpRoleId: invite.mcpRoleId });
      }
    }

    // Mark invitation as used
    await this.prisma.invitationToken.update({
      where: { id: invite.id },
      data: { usedAt: new Date() },
    });

    // Generate auth token
    const authToken = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: invite.organizationId,
      mcpRoleId: user.mcpRoleId,
    });

    return {
      accessToken: authToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: invite.organizationId,
        emailVerified: true,
      },
    };
  }

  // ── Password Reset ──────────────────────────────────────────────────────────

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ 'auth-strict': { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Req() req: any, @Body() dto: ForgotPasswordDto) {
    // Always return success to prevent email enumeration
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      return { message: 'If the email exists, a reset link has been sent.' };
    }

    // Generate secure token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save token
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token: resetToken,
        expiresAt,
      },
    });

    // Build reset URL
    const resetUrl = `${this.getFrontendUrl(req)}/reset-password?token=${resetToken}`;

    // Send email
    const sent = await this.emailService.sendPasswordResetEmail(
      user.email,
      resetUrl,
    );

    if (!sent) {
      this.logger.warn(
        `Password reset requested for ${dto.email} but email could not be sent (SMTP not configured)`,
      );
    }

    return { message: 'If the email exists, a reset link has been sent.' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ 'auth-strict': { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reset password using token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const resetRecord = await this.prisma.passwordResetToken.findUnique({
      where: { token: dto.token },
    });

    if (!resetRecord) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (resetRecord.usedAt) {
      throw new BadRequestException('This reset link has already been used');
    }

    if (resetRecord.expiresAt < new Date()) {
      throw new BadRequestException('This reset link has expired');
    }

    // Update password
    const newHash = await this.authService.hashPassword(dto.newPassword);
    await this.usersService.update(resetRecord.userId, {
      passwordHash: newHash,
    });

    // Mark token as used
    await this.prisma.passwordResetToken.update({
      where: { id: resetRecord.id },
      data: { usedAt: new Date() },
    });

    return { message: 'Password has been reset successfully' };
  }
}
