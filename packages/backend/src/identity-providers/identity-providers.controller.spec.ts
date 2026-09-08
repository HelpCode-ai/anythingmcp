import { IdentityProvidersController } from './identity-providers.controller';
import { SecurityEventService } from '../audit/security-event.service';
import { PrismaService } from '../common/prisma.service';

/**
 * These tests drive the controller through the REAL SecurityEventService so the
 * audit row is what actually reaches the database, redaction included.
 *
 * A mocked event service would pass while the persisted row was wrong: the
 * redaction happens inside `log()`, after the controller has handed over its
 * metadata, so nothing the controller can be asserted on in isolation reflects
 * what an auditor would later read.
 */
describe('IdentityProvidersController audit trail', () => {
  let controller: IdentityProvidersController;
  let service: any;
  let created: any[];

  const provider = {
    id: 'p1',
    type: 'ENTRA',
    name: 'Sign in with Microsoft',
    issuer: 'https://login.microsoftonline.com/tid/v2.0',
    clientId: 'c1',
    config: { tenantId: 'tid' },
    isActive: true,
    jitProvisioning: false,
    roleSyncEnabled: false,
    clientSecretExpiresAt: null,
  };

  const req = {
    user: { organizationId: 'org-1', sub: 'user-1' },
    ip: '203.0.113.1',
    headers: { 'user-agent': 'jest' },
  };

  beforeEach(() => {
    created = [];
    const prisma = {
      securityEvent: {
        create: jest.fn(async (args: any) => {
          created.push(args.data);
          return args.data;
        }),
      },
    };
    service = {
      findByIdForOrg: jest.fn().mockResolvedValue(provider),
      update: jest.fn().mockResolvedValue(provider),
    };
    controller = new IdentityProvidersController(
      service,
      new SecurityEventService(prisma as unknown as PrismaService),
    );
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      type: 'ENTRA',
      name: 'Sign in with Microsoft',
      clientId: 'c1',
      ...over,
    }) as any;

  it('records a credential rotation as a readable boolean, not "[REDACTED]"', async () => {
    // REGRESSION GUARD, and the second time this exact bug shipped. The flag was
    // first named `secretRotated`, renamed to `credentialRotated` to dodge the
    // redaction pattern — but that pattern lists BOTH "secret" and "credential"
    // and matches the KEY, so it kept persisting as the string "[REDACTED]".
    // The audit trail silently lost the answer to "did an admin swap the
    // client secret?", which is precisely the event worth alerting on.
    await controller.update(req, 'p1', dto({ clientSecret: 'NEW-SECRET' }));

    const updateEvent = created.find((e) => e.event === 'IDP_UPDATED');
    expect(updateEvent.metadata.rotated).toBe(true);

    // Guards the general failure mode rather than only today's key name: no
    // value anywhere in the metadata may have collapsed to the redaction
    // marker, which is what a banned substring in a key silently produces.
    expect(JSON.stringify(updateEvent.metadata)).not.toContain('[REDACTED]');
  });

  it('records a save that leaves the credential alone as rotated: false', async () => {
    await controller.update(req, 'p1', dto());

    const updateEvent = created.find((e) => e.event === 'IDP_UPDATED');
    expect(updateEvent.metadata.rotated).toBe(false);
    // No rotation happened, so no rotation event may be claimed.
    expect(created.some((e) => e.event === 'IDP_SECRET_ROTATED')).toBe(false);
  });

  it('never writes the client secret itself into the audit row', async () => {
    await controller.update(req, 'p1', dto({ clientSecret: 'SUPER-SECRET' }));

    expect(JSON.stringify(created)).not.toContain('SUPER-SECRET');
  });
});
