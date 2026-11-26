import { ForbiddenException } from '@nestjs/common';

/** The answer for a dashboard-only action requested with an API key. */
export const DASHBOARD_SIGN_IN_REQUIRED = 'Use a dashboard sign-in for this action';

/**
 * Whether `JwtOrManagementKeyGuard` authenticated this request with a
 * management API key rather than a dashboard session. The guard sets
 * `mcpKeyScope` only on the key path, so a JWT request never carries it.
 */
export function isApiKeyRequest(req: unknown): boolean {
  return !!(req as { mcpKeyScope?: unknown } | undefined)?.mcpKeyScope;
}

/**
 * Refuse an action that hands out a dashboard session or changes the owner's
 * active workspace: an API key acts in one workspace and never becomes a
 * session.
 */
export function refuseApiKeyRequest(req: unknown): void {
  if (isApiKeyRequest(req)) throw new ForbiddenException(DASHBOARD_SIGN_IN_REQUIRED);
}
