import { anonymousSignInProviders } from './sign-in-providers';

/** Which identity providers an unauthenticated page may show. */
describe('anonymousSignInProviders', () => {
  const rows = [
    { id: 'p1', name: 'Directory A', type: 'OIDC', initiateId: 'i1', organizationId: 'org-a' },
    { id: 'p2', name: 'Directory B', type: 'ENTRA', initiateId: 'i2', organizationId: 'org-b' },
  ];
  const prisma = () => ({ identityProvider: { findMany: jest.fn(async () => rows) } });

  it('lists every active provider of a self-hosted instance, oldest first', async () => {
    const db = prisma();
    const providers = await anonymousSignInProviders(db as any, { isCloud: () => false });

    expect(providers).toEqual(rows);
    expect(db.identityProvider.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true, name: true, type: true, initiateId: true, organizationId: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('lists none on Cloud, without a query', async () => {
    const db = prisma();
    expect(await anonymousSignInProviders(db as any, { isCloud: () => true })).toEqual([]);
    expect(db.identityProvider.findMany).not.toHaveBeenCalled();
  });

  it('never selects a secret or the client configuration', async () => {
    const db = prisma();
    await anonymousSignInProviders(db as any, { isCloud: () => false });
    const [{ select }] = db.identityProvider.findMany.mock.calls[0] as any;
    expect(Object.keys(select).sort()).toEqual(['id', 'initiateId', 'name', 'organizationId', 'type']);
  });
});
