/**
 * DEV ONLY — seeds an Entra identity provider from environment variables.
 *
 * The product configures identity providers through the dashboard and stores
 * them in the database; there is deliberately no env-var path at runtime. This
 * script exists purely so a developer does not have to retype a client secret
 * into the UI after every database reset. It writes through the same service
 * as the UI, so the secret is encrypted with the same AAD binding and the same
 * validation applies — it is an input channel, not a second source of truth.
 *
 *   ENTRA_SSO_TENANT_ID       tenant GUID
 *   ENTRA_SSO_CLIENT_ID       application (client) id
 *   ENTRA_SSO_CLIENT_SECRET   the secret VALUE (never logged by this script)
 *   ENTRA_SSO_CLIENT_SECRET_EXPIRY_DATE   ISO date, optional
 *   ENTRA_SSO_ORG_ID          target organization; defaults to the oldest one
 *
 * Usage:  npx tsx scripts/seed-entra-idp.ts
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { IdentityProvidersService } from '../src/identity-providers/identity-providers.service';
import { DeploymentService } from '../src/common/deployment.service';

async function main() {
  const required = ['ENTRA_SSO_TENANT_ID', 'ENTRA_SSO_CLIENT_ID', 'ENTRA_SSO_CLIENT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const service = new IdentityProvidersService(
    prisma as any,
    new DeploymentService(),
  );

  const orgId =
    process.env.ENTRA_SSO_ORG_ID ??
    (await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id;
  if (!orgId) {
    console.error('No organization found. Create one first.');
    process.exit(1);
  }

  const input = {
    type: 'ENTRA' as const,
    name: process.env.ENTRA_SSO_NAME ?? 'Sign in with Microsoft',
    clientId: process.env.ENTRA_SSO_CLIENT_ID!,
    clientSecret: process.env.ENTRA_SSO_CLIENT_SECRET!,
    clientSecretExpiresAt: process.env.ENTRA_SSO_CLIENT_SECRET_EXPIRY_DATE || undefined,
    config: { tenantId: process.env.ENTRA_SSO_TENANT_ID! },
    jitProvisioning: process.env.ENTRA_SSO_JIT === 'true',
    jitDefaultRole: process.env.ENTRA_SSO_JIT === 'true' ? ('VIEWER' as const) : undefined,
  };

  const existing = await prisma.identityProvider.findFirst({
    where: { organizationId: orgId, type: 'ENTRA' },
    select: { id: true },
  });

  const result = existing
    ? await service.update(existing.id, orgId, input)
    : await service.create(orgId, input);

  // Never print the secret — only the identifiers, which are public.
  console.log(existing ? 'Updated Entra provider:' : 'Created Entra provider:');
  console.log(`  organization : ${orgId}`);
  console.log(`  issuer       : ${result?.issuer}`);
  console.log(`  JIT          : ${result?.jitProvisioning ? 'on (VIEWER)' : 'off'}`);
  console.log(`  sign-in link : /sso/${result?.initiateId}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
