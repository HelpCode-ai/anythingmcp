import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_BUILD_DATE, APP_COMMIT, APP_VERSION } from '../common/app-version';
import { DeploymentService } from '../common/deployment.service';

/**
 * Build identity for signed-in users.
 *
 * Kept off `/health/server-info`. That route is unauthenticated, and a
 * version there is a free fingerprint for vulnerability scanners.
 */
@ApiTags('Version')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api')
export class VersionController {
  constructor(private readonly deployment: DeploymentService) {}

  @Get('version')
  @ApiOperation({ summary: 'Version, commit and deployment mode of this instance' })
  getVersion(): {
    version: string;
    commit: string;
    buildDate: string | null;
    deploymentMode: string;
  } {
    return {
      version: APP_VERSION,
      // Full SHA. The startup log and the footer shorten it for display.
      commit: APP_COMMIT,
      buildDate: APP_BUILD_DATE,
      deploymentMode: this.deployment.mode,
    };
  }
}
