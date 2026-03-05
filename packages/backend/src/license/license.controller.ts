import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IsString, Matches } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { LicenseService } from './license.service';
import { UsersService } from '../users/users.service';

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
    private readonly usersService: UsersService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current license status' })
  async getStatus() {
    const license = await this.licenseService.getCurrentLicense();
    if (!license) {
      return { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
    }
    return {
      plan: license.plan,
      status: license.status,
      features: license.features,
      expiresAt: license.expiresAt,
      lastVerifiedAt: license.lastVerifiedAt,
      instanceId: license.instanceId,
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
  async setLicenseKey(@Body() dto: SetLicenseKeyDto) {
    try {
      const license = await this.licenseService.setLicenseKey(dto.licenseKey);
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
