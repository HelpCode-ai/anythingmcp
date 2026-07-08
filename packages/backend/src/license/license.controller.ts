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
import { IsString, IsOptional, Matches } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { LicenseService } from './license.service';
import { LicenseGuardService } from './license-guard.service';
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

class BillingPortalDto {
  @IsOptional()
  @IsString()
  returnUrl?: string;
}

@ApiTags('License')
@Controller('api/license')
export class LicenseController {
  private readonly logger = new Logger(LicenseController.name);

  constructor(
    private readonly licenseService: LicenseService,
    private readonly licenseGuard: LicenseGuardService,
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
        organizationId = payload.organizationId ?? undefined;
      } catch {}
    }

    // In cloud mode, require auth — don't leak license status to unauthenticated users
    if (this.deployment.isCloud() && !organizationId) {
      return { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
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

  @Get('usage')
  @ApiOperation({
    summary:
      'Current usage vs caps for the org. Drives the soft-warn upgrade banner in the UI.',
  })
  async getUsage(@Req() req: any) {
    // Optional auth — anonymous self-hosted single-user instances still get
    // their global usage. Cloud requires an org-scoped JWT.
    let organizationId: string | undefined;
    let userId: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.authService.verifyToken(authHeader.substring(7));
        organizationId = payload.organizationId ?? undefined;
        userId = payload.sub ?? undefined;
      } catch {}
    }

    if (this.deployment.isCloud() && !organizationId) {
      return {
        plan: null,
        connectors: { current: 0, max: null, isOver: false },
        mcpServers: { current: 0, max: null, isOver: false },
        users: { current: 0, max: null, isOver: false },
        isOverAny: false,
      };
    }

    return this.licenseGuard.getUsage(userId, organizationId);
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

  @Post('billing-portal')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Open the Stripe billing portal for the current subscription (ADMIN)',
  })
  async billingPortal(@Req() req: any, @Body() dto: BillingPortalDto) {
    try {
      return await this.licenseService.createBillingPortalSession(
        req.user.organizationId,
        dto?.returnUrl,
      );
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to open billing portal');
    }
  }

  @Post('verify')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Force re-verify license against remote API (ADMIN)' })
  async verifyLicense(@Req() req: any) {
    const result = await this.licenseService.verifyLicense(undefined, req.user.organizationId);
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
        req.user.organizationId,
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
