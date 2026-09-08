import { NotFoundException } from '@nestjs/common';
import { SelfHostedOnlyGuard } from './self-hosted-only.guard';

describe('SelfHostedOnlyGuard', () => {
  const ctx = {} as any;

  it('lets requests through on a self-hosted deployment', () => {
    const guard = new SelfHostedOnlyGuard({
      mode: 'self-hosted',
      isCloud: () => false,
      isSelfHosted: () => true,
    } as any);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // 404 and not 403: a 403 confirms the endpoint exists and is merely switched
  // off here, which tells a prober exactly where to come back to.
  it('answers 404 in cloud, not 403', () => {
    const guard = new SelfHostedOnlyGuard({
      mode: 'cloud',
      isCloud: () => true,
      isSelfHosted: () => false,
    } as any);
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  // DEPLOYMENT_MODE unset must mean self-hosted: a community operator who never
  // sets the variable has to get the feature, not lose it.
  it('treats an unset deployment mode as self-hosted', () => {
    const previous = process.env.DEPLOYMENT_MODE;
    delete process.env.DEPLOYMENT_MODE;
    try {
      const { DeploymentService } = require('./deployment.service');
      expect(new SelfHostedOnlyGuard(new DeploymentService()).canActivate(ctx)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
    }
  });
});
