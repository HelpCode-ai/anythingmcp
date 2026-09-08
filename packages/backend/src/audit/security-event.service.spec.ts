import { SecurityEventService, SecurityEvents } from './security-event.service';
import { PrismaService } from '../common/prisma.service';

describe('SecurityEventService', () => {
  let service: SecurityEventService;
  let prisma: { securityEvent: { create: jest.Mock } };

  const dataOf = () => prisma.securityEvent.create.mock.calls[0][0].data;

  beforeEach(() => {
    prisma = { securityEvent: { create: jest.fn().mockResolvedValue({}) } };
    service = new SecurityEventService(prisma as unknown as PrismaService);
  });

  describe('log', () => {
    it('persists an event with its actor, org and target', async () => {
      await service.log({
        event: SecurityEvents.ROLE_CHANGED,
        actorType: 'USER',
        organizationId: 'org-1',
        actorUserId: 'admin-1',
        targetUserId: 'user-2',
        ip: '203.0.113.5',
        userAgent: 'Claude/1.0',
      });

      expect(dataOf()).toMatchObject({
        event: 'ROLE_CHANGED',
        actorType: 'USER',
        organizationId: 'org-1',
        actorUserId: 'admin-1',
        targetUserId: 'user-2',
        ip: '203.0.113.5',
        userAgent: 'Claude/1.0',
      });
    });

    it('allows a null organization so pre-resolution events are not lost', async () => {
      // A rejected token or a login for an unknown user happens before any org
      // is known. Those are the rows an investigation needs most.
      await service.log({
        event: SecurityEvents.TOKEN_REJECTED,
        actorType: 'ANONYMOUS',
      });

      expect(dataOf().organizationId).toBeNull();
      expect(dataOf().actorUserId).toBeNull();
    });

    it('never throws when the write fails', async () => {
      // An audit failure must not deny a legitimate request, nor give an
      // attacker a way to break the flow by breaking the write.
      prisma.securityEvent.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.log({ event: SecurityEvents.SSO_LOGIN_SUCCESS, actorType: 'USER' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('redaction', () => {
    it('redacts secret-bearing keys in every casing and separator style', async () => {
      await service.log({
        event: SecurityEvents.IDP_UPDATED,
        actorType: 'USER',
        metadata: {
          clientId: 'keep-me',
          clientSecret: 'sh-should-not-persist',
          client_secret: 'sh-should-not-persist',
          CLIENT_SECRET: 'sh-should-not-persist',
          password: 'hunter2',
          refresh_token: 'rt-abc',
          id_token: 'eyJhbGciOi...',
          code_verifier: 'v-abc',
          apiKey: 'ak-1',
          authorization: 'Bearer abc',
        },
      });

      const md = dataOf().metadata;
      expect(md.clientId).toBe('keep-me');
      for (const key of [
        'clientSecret',
        'client_secret',
        'CLIENT_SECRET',
        'password',
        'refresh_token',
        'id_token',
        'code_verifier',
        'apiKey',
        'authorization',
      ]) {
        expect(md[key]).toBe('[REDACTED]');
      }
      // Belt and braces: no secret value survives anywhere in the payload.
      expect(JSON.stringify(md)).not.toContain('sh-should-not-persist');
      expect(JSON.stringify(md)).not.toContain('hunter2');
    });

    it('redacts nested secrets', async () => {
      await service.log({
        event: SecurityEvents.IDP_UPDATED,
        actorType: 'USER',
        metadata: { before: { tenantId: 't1', clientSecret: 'old' }, after: { tenantId: 't2' } },
      });

      const md = dataOf().metadata;
      expect(md.before.tenantId).toBe('t1');
      expect(md.before.clientSecret).toBe('[REDACTED]');
      expect(md.after.tenantId).toBe('t2');
    });

    it('truncates oversized strings', async () => {
      // A 200-group Entra claim is ~7 KB; an id_token is larger. Rows must not
      // become a dumping ground for whole token payloads.
      await service.log({
        event: SecurityEvents.SSO_LOGIN_SUCCESS,
        actorType: 'USER',
        metadata: { note: 'x'.repeat(5000) },
      });

      expect(dataOf().metadata.note).toHaveLength(512 + '…[truncated]'.length);
      expect(dataOf().metadata.note.endsWith('…[truncated]')).toBe(true);
    });

    it('caps array length and recursion depth', async () => {
      await service.log({
        event: SecurityEvents.SSO_LOGIN_SUCCESS,
        actorType: 'USER',
        metadata: {
          groups: Array.from({ length: 200 }, (_, i) => `g${i}`),
          deep: { a: { b: { c: { d: { e: 'too far' } } } } },
        },
      });

      const md = dataOf().metadata;
      expect(md.groups).toHaveLength(50);
      expect(JSON.stringify(md.deep)).not.toContain('too far');
    });

    it('leaves the identifiers an investigation needs intact', async () => {
      // oid/tid are not secrets — they are exactly what you need to correlate.
      await service.log({
        event: SecurityEvents.SSO_LOGIN_SUCCESS,
        actorType: 'USER',
        metadata: { oid: 'a-guid', tid: 'tenant-guid', reason: 'iss_mismatch' },
      });

      expect(dataOf().metadata).toEqual({
        oid: 'a-guid',
        tid: 'tenant-guid',
        reason: 'iss_mismatch',
      });
    });
  });

  // Regression: the depth cut-off used to emit the same '[REDACTED]' string as
  // a real key match, so an audit row that had simply nested too far was
  // indistinguishable from one that had a credential stripped out of it.
  it('marks a depth cut-off as truncation, not redaction', async () => {
    await service.log({
      event: 'IDP_ROLE_MAPPING_CHANGED',
      actorType: 'USER',
      metadata: { after: [{ mcpRoleIds: ['role_1'] }] },
    });
    const written = (prisma.securityEvent.create as jest.Mock).mock.calls[0][0].data.metadata;
    expect(written.after[0].mcpRoleIds[0]).toBe('[TRUNCATED:depth]');
    expect(written.after[0].mcpRoleIds[0]).not.toBe('[REDACTED]');
  });

  it('still redacts on a key match at any depth', async () => {
    await service.log({
      event: 'IDP_UPDATED',
      actorType: 'USER',
      metadata: { before: { clientSecret: 'hunter2' } },
    });
    const written = (prisma.securityEvent.create as jest.Mock).mock.calls[0][0].data.metadata;
    expect(written.before.clientSecret).toBe('[REDACTED]');
  });
});
