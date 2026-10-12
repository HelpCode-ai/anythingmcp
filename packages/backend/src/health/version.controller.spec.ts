import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { APP_BUILD_DATE, APP_COMMIT, APP_VERSION } from '../common/app-version';
import { DeploymentService } from '../common/deployment.service';
import { VersionController } from './version.controller';

describe('VersionController', () => {
  it('requires a JWT', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, VersionController);
    expect(guards).toEqual([AuthGuard('jwt')]);
  });

  it('returns the full commit and the deployment mode', () => {
    const deployment = { mode: 'self-hosted' } as DeploymentService;
    const body = new VersionController(deployment).getVersion();
    expect(body).toEqual({
      version: APP_VERSION,
      commit: APP_COMMIT,
      buildDate: APP_BUILD_DATE,
      deploymentMode: 'self-hosted',
    });
  });
});
