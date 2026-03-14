import { Injectable } from '@nestjs/common';

export type DeploymentMode = 'self-hosted' | 'cloud';

@Injectable()
export class DeploymentService {
  readonly mode: DeploymentMode =
    (process.env.DEPLOYMENT_MODE as DeploymentMode) || 'self-hosted';

  isCloud(): boolean {
    return this.mode === 'cloud';
  }

  isSelfHosted(): boolean {
    return this.mode !== 'cloud';
  }
}
