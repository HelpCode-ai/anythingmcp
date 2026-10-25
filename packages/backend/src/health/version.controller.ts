import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { APP_VERSION, APP_COMMIT, APP_BUILD_DATE } from '../common/app-version';

@ApiTags('Version')
@Controller('api/version')
@UseGuards(AuthGuard('jwt'))
export class VersionController {
  @Get()
  @ApiBearerAuth()
  getVersion() {
    return {
      version: APP_VERSION,
      commit: APP_COMMIT,
      buildDate: APP_BUILD_DATE,
      deploymentMode: process.env.DEPLOYMENT_MODE || 'self-hosted',
    };
  }
}
