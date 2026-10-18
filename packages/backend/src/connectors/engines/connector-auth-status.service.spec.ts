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

  it('works without an email service (self-hosted without SMTP)', async () => {
    const quiet = new ConnectorAuthStatusService(prisma as any);
    await quiet.mark('conn-1', issue);
    expect(row.authStatus).toBe('needs_reauth');
    expect(row.authNotifiedAt).toBeNull();
  });
});
