import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeploymentService } from './deployment.service';

/**
 * Restricts a route to self-hosted deployments.
 *
 * Single sign-on is an enterprise, self-hosted capability: the workspace owns
 * its own directory, its own tenant and its own operator. In cloud the same
 * feature would let any customer point a workspace at an arbitrary directory
 * and start provisioning accounts inside a shared, multi-tenant deployment —
 * a materially different trust model from the one the SSO code was written
 * against.
 *
 * Answers 404 rather than 403 on purpose. A 403 confirms the endpoint exists
 * and is merely switched off here, which is an invitation; 404 says the same
 * thing the router would say about any URL this deployment does not serve.
 */
@Injectable()
export class SelfHostedOnlyGuard implements CanActivate {
  constructor(private readonly deployment: DeploymentService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (this.deployment.isSelfHosted()) return true;
    throw new NotFoundException('Not found');
  }
}
