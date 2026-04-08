import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, Matches } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { LicenseService } from './license.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { DeploymentService } from '../common/deployment.service';

class SetLicenseKeyDto {
  @IsString()
  @Matches(/^AMCP-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}$/, {
    message: 'Invalid license key format. Expected: AMCP-XXXX-XXXX-XXXX-XXXX',
  })
  licenseKey: string;
}

@ApiTags('License')
@Controller('api/license')
export class LicenseController {
  private readonly logger = new Logger(LicenseController.name);

  constructor(
    private readonly licenseService: LicenseService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly deployment: DeploymentService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current license status (optional auth for org-scoped results)' })
  async getStatus(@Req() req: any) {
    // Optional auth: extract organizationId from JWT if present
    let organizationId: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.authService.verifyToken(authHeader.substring(7));
        organizationId = payload.organizationId;
      } catch {}
    }
    const license = await this.licenseService.getCurrentLicense(organizationId);
    if (!license) {
      return { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
    }

    const trialDaysLeft =
      license.plan === 'trial' && license.expiresAt
        ? Math.max(0, Math.ceil((new Date(license.expiresAt).getTime() - Date.now()) / 86400000))
        : undefined;

    return {
      plan: license.plan,
      status: license.status,
      features: license.features,
      expiresAt: license.expiresAt,
      lastVerifiedAt: license.lastVerifiedAt,
      instanceId: license.instanceId,
      ...(trialDaysLeft !== undefined && { trialDaysLeft }),
    };
  }

  @Get('instance-id')
  @ApiOperation({ summary: 'Get the instance ID' })
  async getInstanceId() {
    const instanceId = await this.licenseService.getInstanceId();
    return { instanceId };
  }

  @Put('key')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set and activate a license key (ADMIN)' })
  async setLicenseKey(@Req() req: any, @Body() dto: SetLicenseKeyDto) {
    try {
      const license = await this.licenseService.setLicenseKey(dto.licenseKey, req.user.organizationId);
      return { message: 'License activated successfully', license };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to activate license');
    }
  }

  @Post('verify')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Force re-verify license against remote API (ADMIN)' })
  async verifyLicense() {
    const result = await this.licenseService.verifyLicense();
    return result;
  }

  @Post('activate-trial')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a 7-day cloud trial (cloud mode only)' })
  async activateTrial(@Req() req: any) {
    if (!this.deployment.isCloud()) {
      throw new ForbiddenException('Trial activation is only available in cloud mode');
    }

    const user = await this.usersService.findById(req.user.sub);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    try {
      const result = await this.licenseService.requestTrialLicense(
        user.email,
        user.name || user.email,
      );
      return {
        message: 'Trial activated successfully',
        trialStarted: true,
        ...result,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to activate trial');
    }
  }

  @Post('register-community')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Request a free community license (sent via email)' })
  async registerCommunity(@Req() req: any) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    try {
      const result = await this.licenseService.requestCommunityLicense(
        user.email,
        user.name || user.email,
      );
      return { message: result.message, email: user.email };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to register community license');
    }
  }
}
