import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Observable } from 'rxjs';

/**
 * Tags Sentry events and spans with the organization the request acted for, so an
 * error can be traced to the customer who hit it without sending who they
 * are: the internal id only, never an e-mail or a name.
 *
 * Runs after the guards, so `req.user` is populated for authenticated
 * dashboard requests. No-op when Sentry is not initialised.
 */
@Injectable()
export class SentryContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http' && Sentry.isInitialized()) {
      const req = context.switchToHttp().getRequest<{ user?: { organizationId?: string | null } }>();
      const orgId = req?.user?.organizationId;
      if (orgId) {
        const scope = Sentry.getIsolationScope();
        // Tags reach errors only; spans (SDK v11) carry attributes instead.
        scope.setTag('org_id', orgId);
        scope.setAttribute('org_id', orgId);
      }
    }
    return next.handle();
  }
}
