import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeploymentService } from './deployment.service';

/**
 * Restricts a route to AnythingMCP Cloud (`DEPLOYMENT_MODE=cloud`).
 *
 * The mirror of {@link SelfHostedOnlyGuard}, and for the same reason it answers
 * 404 rather than 403: on a self-hosted instance the route simply does not
 * exist.
 */
@Injectable()
export class CloudOnlyGuard implements CanActivate {
  constructor(private readonly deployment: DeploymentService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (this.deployment.isCloud()) return true;
    throw new NotFoundException('Not found');
  }
}
