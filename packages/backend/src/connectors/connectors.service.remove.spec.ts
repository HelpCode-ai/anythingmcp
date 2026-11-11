import { ConnectorsService } from './connectors.service';

/**
 * Deleting an Instagram connector deletes its tool-call log rows in the same
 * transaction (Meta Platform Terms: Instagram data goes with the connector),
 * scoped to the connector and its workspace. Other connectors are deleted
 * as before.
 */
describe('ConnectorsService.remove', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const prisma = {
    connector: { delete: jest.fn((args) => ({ op: 'connector.delete', args })) },
    toolInvocation: { deleteMany: jest.fn((args) => ({ op: 'toolInvocation.deleteMany', args })) },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const service = new ConnectorsService(prisma as any, { get: () => KEY } as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it.each(['instagram', 'instagram-login'])('deletes the tool-call logs of a %s connector with it', async (slug) => {
    jest.spyOn(service, 'findById').mockResolvedValue({ id: 'c1', organizationId: 'org1', config: { adapterSlug: slug } } as any);
    await service.remove('c1');
    expect(prisma.toolInvocation.deleteMany).toHaveBeenCalledWith({ where: { connectorId: 'c1', organizationId: 'org1' } });
    expect(prisma.$transaction).toHaveBeenCalledWith([
      { op: 'toolInvocation.deleteMany', args: { where: { connectorId: 'c1', organizationId: 'org1' } } },
      { op: 'connector.delete', args: { where: { id: 'c1' } } },
    ]);
  });

  it('leaves the logs of any other connector to the existing relations', async () => {
    jest.spyOn(service, 'findById').mockResolvedValue({ id: 'c2', organizationId: 'org1', config: { adapterSlug: 'github' } } as any);
    await service.remove('c2');
    expect(prisma.toolInvocation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.connector.delete).toHaveBeenCalledWith({ where: { id: 'c2' } });
  });
});
