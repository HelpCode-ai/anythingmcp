import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { MemberVisibilityService } from './member-visibility.service';
import { routeVisibility } from './member-visibility.routes';

/** What a restricted member gets on an `admin-when-restricted` route. */
export const ADMIN_WHEN_RESTRICTED_MESSAGE =
  'In this workspace, members see only what their roles share with them. Ask a workspace admin.';

/**
 * Enforces the `admin-when-restricted` decisions of member-visibility.routes.ts:
 * a member who is not an admin, in a workspace set to `restricted`, gets 403
 * before the handler runs. Every other route, every admin and every open
 * workspace pass through untouched (a map lookup, no database read).
 *
 * An interceptor rather than a guard because interceptors run after the
 * controller's own guards, so `req.user` is set; and because it applies the
 * decision without changing the controllers it protects (some live under
 * ee/). Fails closed like `scopeFor`: if the mode or role lookup throws, the
 * request fails.
 */
@Injectable()
export class MemberVisibilityInterceptor implements NestInterceptor {
  constructor(private readonly visibility: MemberVisibilityService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const rule = routeVisibility(context.getClass().name, context.getHandler().name);
    if (rule?.decision !== 'admin-when-restricted') return next.handle();
    const user = context.switchToHttp().getRequest()?.user;
    // No user: the route's own guard decides (it has already run and let the
    // request through only if the route allows that).
    if (!user || user.role === 'ADMIN') return next.handle();
    const scope = await this.visibility.scopeFor(user);
    if (scope.restricted) throw new ForbiddenException(ADMIN_WHEN_RESTRICTED_MESSAGE);
    return next.handle();
  }
}
