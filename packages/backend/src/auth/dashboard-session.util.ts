import type { Request } from 'express';
import type { PrismaService } from '../common/prisma.service';
import type { DeploymentService } from '../common/deployment.service';
import {
  type AuthService,
  DASHBOARD_TOKEN_USE,
  isForeignIssuedToken,
  isTokenRevoked,
} from './auth.service';

/**
 * The dashboard session cookie. Set by the frontend on sign-in (see
 * `auth-context.tsx`) on the same origin that proxies /auth/* to the backend,
 * so it arrives with top-level navigations to the pages served there.
 */
export const DASHBOARD_SESSION_COOKIE = 'amcp_token';

/** A user identified from a still-valid dashboard session. */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The user behind this browser's dashboard session, or null. Used by the
 * pages the backend serves under /auth/ (the MCP sign-in, the connect page).
 *
 * Applies what `JwtStrategy` + `EmailVerifiedGuard` apply to the dashboard
 * API — signature and expiry, a dashboard-issued token (not an MCP token
 * signed with the same secret), not revoked, at least one active membership,
 * and a verified email in cloud — because approving here is no more than
 * the dashboard itself already lets this session do. Anything off falls
 * back to the password form rather than erroring.
 */
export async function resolveDashboardSessionUser(
  req: Request,
  deps: {
    authService: Pick<AuthService, 'verifyToken'>;
    prisma: Pick<PrismaService, 'user'>;
    deployment: Pick<DeploymentService, 'isCloud'>;
  },
): Promise<SessionUser | null> {
  const token = req.cookies?.[DASHBOARD_SESSION_COOKIE];
  if (typeof token !== 'string' || !token) return null;

  let payload: ReturnType<AuthService['verifyToken']>;
  try {
    payload = deps.authService.verifyToken(token);
  } catch {
    return null;
  }
  if (
    !payload?.sub ||
    payload.tokenUse !== DASHBOARD_TOKEN_USE ||
    isForeignIssuedToken(payload as unknown as Record<string, unknown>)
  ) {
    return null;
  }

  const user = await deps.prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      sessionsValidFrom: true,
      memberships: {
        where: { deactivatedAt: null },
        select: { organizationId: true },
        take: 1,
      },
    },
  });
  if (!user) return null;
  if (isTokenRevoked(payload, user.sessionsValidFrom)) return null;
  if (user.memberships.length === 0) return null;
  if (deps.deployment.isCloud() && !user.emailVerified) return null;

  return { id: user.id, email: user.email, name: user.name };
}
