import { ConnectorAuthStatusService, credentialRef } from './connector-auth-status.service';

/** The owner email goes out in the background; let it finish. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Just enough of Prisma's where-clause semantics for one connector row. */
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as any[]).some((c) => matches(row, c));
    const value = row[key] ?? null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) return cond.not === null ? value !== null : value !== null && value !== cond.not;
      if ('in' in cond) return cond.in.includes(value);
    }
    return value === (cond ?? null);
  });
}

function fakePrisma(row: Record<string, any>) {
  return {
    connector: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === row.id ? { ...row } : null)),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      findMany: jest.fn(async ({ where }: any) =>
        row.authStatus === where.authStatus && row.tokenExpiresAt && row.tokenExpiresAt <= where.tokenExpiresAt.lte
          ? [{ id: row.id, authStatusRef: row.authStatusRef ?? null, tokenExpiresAt: row.tokenExpiresAt }]
          : [],
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    organizationMember: {
      findFirst: jest.fn(async () => ({ user: { email: 'owner@example.com', name: 'Rich' } })),
    },
  };
}

describe('ConnectorAuthStatusService', () => {
  const issue = {
    status: 'needs_reauth' as const,
    code: 'google_testing_7d',
    message: 'Google revoked the sign-in 7 days after it was granted.',
    ref: credentialRef('rt-dead'),
  };
  let row: Record<string, any>;
  let prisma: ReturnType<typeof fakePrisma>;
  let email: { sendConnectorAuthEmail: jest.Mock };
  let service: ConnectorAuthStatusService;

  beforeEach(() => {
    row = { id: 'conn-1', name: 'Search Console', organizationId: 'org-1', authStatus: null, authNotifiedAt: null };
    prisma = fakePrisma(row);
    email = { sendConnectorAuthEmail: jest.fn(async () => true) };
    service = new ConnectorAuthStatusService(prisma as any, email as any);
  });

  it('stores when and why, and emails the owner once however often it is marked', async () => {
    await service.mark('conn-1', issue);
    await flush();
    await service.mark('conn-1', issue);
    await flush();
    await service.mark('conn-1', issue);
    await flush();

    expect(row).toMatchObject({
      authStatus: 'needs_reauth',
      authStatusCode: 'google_testing_7d',
      authStatusMessage: issue.message,
      authStatusRef: issue.ref,
    });
    expect(row.authStatusAt).toBeInstanceOf(Date);
    expect(row.authNotifiedAt).toBeInstanceOf(Date);
    expect(prisma.connector.update).toHaveBeenCalledTimes(1);
    expect(email.sendConnectorAuthEmail).toHaveBeenCalledTimes(1);
    expect(email.sendConnectorAuthEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        name: 'Rich',
        connectorName: 'Search Console',
        message: issue.message,
        connectorPath: '/connectors/conn-1',
      }),
      'org-1',
    );
  });

  it('does not email about a warning', async () => {
    await service.mark('conn-1', { ...issue, status: 'expiring', code: 'meta_expiring' });
    expect(row.authStatus).toBe('expiring');
    expect(email.sendConnectorAuthEmail).not.toHaveBeenCalled();
  });

  it('clears everything on a working credential, so a later refusal is a new incident', async () => {
    await service.mark('conn-1', issue);
    await flush();
    await service.clear('conn-1');
    expect(row).toMatchObject({ authStatus: null, authStatusCode: null, authStatusMessage: null, authNotifiedAt: null });

    await service.mark('conn-1', { ...issue, ref: credentialRef('rt-next') });
    await flush();
    expect(email.sendConnectorAuthEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps a status recorded against the same credential when asked to', async () => {
    await service.mark('conn-1', issue);
    await flush();
    await service.clear('conn-1', { exceptRef: issue.ref });
    expect(row.authStatus).toBe('needs_reauth');
    await service.clear('conn-1', { exceptRef: credentialRef('another-token') });
    expect(row.authStatus).toBeNull();
  });

  it('clears only the named reasons with onlyCodes', async () => {
    await service.mark('conn-1', issue);
    await flush();
    await service.clear('conn-1', { onlyCodes: ['meta_expiring'] });
    expect(row.authStatus).toBe('needs_reauth');
  });

  it('never stores the credential itself', async () => {
    await service.mark('conn-1', issue);
    await flush();
    expect(JSON.stringify(row)).not.toContain('rt-dead');
    expect(issue.ref).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('expireLapsedTokens', () => {
    const ref = credentialRef('EAAshortlived');
    const expiresAt = new Date('2026-10-20T17:00:00Z');
    const warn = { status: 'expiring' as const, code: 'meta_expiring', message: 'This is a short-lived token.', ref };

    it('turns a warning whose token has expired into needs_reauth and emails the owner once', async () => {
      await service.mark('conn-1', warn);
      row.tokenExpiresAt = expiresAt;
      await flush();
      expect(email.sendConnectorAuthEmail).not.toHaveBeenCalled();

      const later = new Date('2026-10-21T10:00:00Z');
      expect(await service.expireLapsedTokens(later)).toBe(1);
      await flush();
      expect(row).toMatchObject({ authStatus: 'needs_reauth', authStatusCode: 'token_expired', authStatusRef: ref });
      expect(row.authStatusMessage).toMatch(/expired on 2026-10-20 17:00 UTC and could not be renewed/);
      expect(row.authNotifiedAt).toBeInstanceOf(Date);
      expect(email.sendConnectorAuthEmail).toHaveBeenCalledTimes(1);

      // The next sweep finds nothing left to do.
      expect(await service.expireLapsedTokens(later)).toBe(0);
      await flush();
      expect(email.sendConnectorAuthEmail).toHaveBeenCalledTimes(1);
    });

    it('leaves a warning alone until its token has expired', async () => {
      await service.mark('conn-1', warn);
      row.tokenExpiresAt = expiresAt;
      expect(await service.expireLapsedTokens(new Date('2026-10-20T16:59:00Z'))).toBe(0);
      expect(row.authStatus).toBe('expiring');
    });

    it('only looks at expiring warnings, never at other connectors with an expiry', async () => {
      await service.expireLapsedTokens(new Date());
      expect(prisma.connector.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { authStatus: 'expiring', tokenExpiresAt: { lte: expect.any(Date) } } }),
      );
    });
  });

  it('runs the expiry sweep on a timer that does not keep the process alive', () => {
    jest.useFakeTimers();
    try {
      const spy = jest.spyOn(service, 'expireLapsedTokens').mockResolvedValue(0);
      service.onModuleInit();
      jest.advanceTimersByTime(2 * 60 * 1000);
      expect(spy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(spy).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      jest.advanceTimersByTime(3 * 60 * 60 * 1000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('works without an email service (self-hosted without SMTP)', async () => {
    const quiet = new ConnectorAuthStatusService(prisma as any);
    await quiet.mark('conn-1', issue);
    expect(row.authStatus).toBe('needs_reauth');
    expect(row.authNotifiedAt).toBeNull();
  });
});
