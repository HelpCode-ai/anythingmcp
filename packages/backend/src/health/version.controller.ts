import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { APP_VERSION, APP_COMMIT, APP_BUILD_DATE } from '../common/app-version';

@ApiTags('Version')
@Controller('api/version')
@UseGuards(AuthGuard('jwt'))
export class VersionController {
  @Get()
  getVersion() {
    return {
      version: APP_VERSION,
      commit: APP_COMMIT,
      buildDate: APP_BUILD_DATE,
      deploymentMode: process.env.DEPLOYMENT_MODE || 'self-hosted',
    };
  }
}
