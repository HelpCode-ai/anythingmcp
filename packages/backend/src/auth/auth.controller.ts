import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsEmail, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from '../settings/email.service';
import { Roles, RolesGuard } from './roles.guard';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  name: string;
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
  ) {}

  private getFrontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    );
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body() dto: LoginDto) {
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
      mcpRoleId: user.mcpRoleId,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user account' })
  async register(@Body() dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // First user becomes ADMIN
    const userCount = await this.usersService.count();
    const role = userCount === 0 ? 'ADMIN' : 'EDITOR';

    const passwordHash = await this.authService.hashPassword(dto.password);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
      role: role as any,
    });

    // Create default MCP server for new user
    await this.mcpServersService.createDefaultForUser(user.id);

    const token = this.authService.generateToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      mcpRoleId: user.mcpRoleId,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  // ── Invitation Flow ─────────────────────────────────────────────────────────

  @Post('invite')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invite a user to the workspace (ADMIN only)' })
  async inviteUser(@Req() req: any, @Body() dto: InviteUserDto) {
    // Check if user already exists
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    // Check for existing pending invitation
    const existingInvite = await this.prisma.invitationToken.findFirst({
      where: {
        email: dto.email,
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
        expiresAt,
      },
    });

    // Build invitation URL
    const inviteUrl = `${this.getFrontendUrl()}/accept-invite?token=${inviteToken}`;

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
    const sent = await this.emailService.sendInvitationEmail(
      dto.email,
      inviteUrl,
      inviterName,
      roleName,
    );

    return {
      message: sent
        ? `Invitation sent to ${dto.email}`
        : `Invitation created for ${dto.email} (email could not be sent — SMTP not configured). Share this link manually.`,
      inviteUrl: sent ? undefined : inviteUrl,
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
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    // Create the user with the assigned role and mcpRoleId
    const passwordHash = await this.authService.hashPassword(dto.password);
    const user = await this.usersService.create({
      email: invite.email,
      passwordHash,
      name: dto.name,
      role: invite.role,
    });

    // Create default MCP server for new user
    await this.mcpServersService.createDefaultForUser(user.id);

    // Assign MCP role if specified
    if (invite.mcpRoleId) {
      await this.usersService.update(user.id, { mcpRoleId: invite.mcpRoleId });
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
      mcpRoleId: invite.mcpRoleId,
    });

    return {
      accessToken: authToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  // ── Password Reset ──────────────────────────────────────────────────────────

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
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
    const resetUrl = `${this.getFrontendUrl()}/reset-password?token=${resetToken}`;

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
