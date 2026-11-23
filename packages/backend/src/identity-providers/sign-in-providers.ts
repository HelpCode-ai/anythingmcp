import type { PrismaService } from '../common/prisma.service';
import type { DeploymentService } from '../common/deployment.service';

/** An identity provider as a sign-in page may offer it to somebody who is not signed in yet. */
export interface SignInProvider {
  id: string;
  name: string;
  type: string;
  /** The opaque id of the dashboard entry link (`/sso/<initiateId>`). */
  initiateId: string;
  /** For ordering only. Never rendered. */
  organizationId: string;
}

/**
 * The identity providers a page may show to an anonymous visitor.
 *
 * ONE rule for every unauthenticated page: the dashboard sign-in (through
 * `/health/server-info`) and the MCP authorization page (`/auth/login`). They
 * read it from here, so neither can show a provider the other does not.
 *
 * Self-hosted: every active provider of the instance. There is effectively
 * one organization, and its providers are what the sign-in page is for.
 *
 * Cloud: none. The page is public, so a list would let anyone read off every
 * customer's provider names. Cloud has no organization SSO anyway.
 *
 * Deliberately not filtered by organization: the visitor is not known yet.
 */
export async function anonymousSignInProviders(
  prisma: Pick<PrismaService, 'identityProvider'>,
  deployment: Pick<DeploymentService, 'isCloud'>,
): Promise<SignInProvider[]> {
  if (deployment.isCloud()) return [];
  return prisma.identityProvider.findMany({
    where: { isActive: true },
    select: { id: true, name: true, type: true, initiateId: true, organizationId: true },
    orderBy: { createdAt: 'asc' },
  });
}
