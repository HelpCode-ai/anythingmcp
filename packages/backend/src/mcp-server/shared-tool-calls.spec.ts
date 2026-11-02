import { DailyKeySet, SharedToolCallRecorder, utcDay } from './shared-tool-calls';

function build(rows: Array<{ metadata: unknown }> = []) {
  const prisma = {
    productEvent: { findMany: jest.fn().mockResolvedValue(rows) },
    oAuthClient: { findUnique: jest.fn().mockResolvedValue({ clientName: 'Claude' }) },
  };
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const recorder = new SharedToolCallRecorder(prisma as any, productEvents as any);
  return { prisma, productEvents, recorder };
}

const NOV_2 = Date.UTC(2026, 10, 2, 9, 30);
const call = { organizationId: 'org-1', userId: 'u1', tool: 'anythingmcp_list_connectors', profile: 'default' as const, oauthClientId: 'cl-1' };

describe('shared_tool_called', () => {
  it('writes one row per workspace, tool and UTC day, with the client name', async () => {
    const { prisma, productEvents, recorder } = build();
    await recorder.record(call, NOV_2);
    await recorder.record(call, NOV_2 + 60_000);
    await recorder.record(call, NOV_2 + 10 * 3_600_000);

    expect(productEvents.log).toHaveBeenCalledTimes(1);
    expect(productEvents.log).toHaveBeenCalledWith({
      event: 'shared_tool_called',
      organizationId: 'org-1',
      userId: 'u1',
      metadata: { tool: 'anythingmcp_list_connectors', profile: 'default', client: 'Claude' },
    });
    // The database is asked once, about today only.
    expect(prisma.productEvent.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productEvent.findMany.mock.calls[0][0].where).toEqual({
      event: 'shared_tool_called',
      organizationId: 'org-1',
      createdAt: { gte: new Date('2026-11-02T00:00:00.000Z') },
      metadata: { path: ['tool'], equals: 'anythingmcp_list_connectors' },
    });
  });

  it('starts again on the next UTC day, and counts each tool and workspace apart', async () => {
    const { productEvents, recorder } = build();
    await recorder.record(call, NOV_2);
    await recorder.record(call, Date.UTC(2026, 10, 3, 0, 0, 1));
    await recorder.record({ ...call, tool: 'anythingmcp_search_tools' }, NOV_2);
    await recorder.record({ ...call, organizationId: 'org-2' }, NOV_2);
    expect(productEvents.log).toHaveBeenCalledTimes(4);
  });

  it('keeps setup tools run through the same run tool apart', async () => {
    const { productEvents, recorder } = build();
    const run = { ...call, tool: 'anythingmcp_run_read_tool' };
    await recorder.record(run, NOV_2);
    await recorder.record({ ...run, setupTool: 'setup_find_connectors' }, NOV_2);
    await recorder.record({ ...run, setupTool: 'setup_find_connectors' }, NOV_2);
    await recorder.record({ ...run, setupTool: 'setup_get_status' }, NOV_2);
    expect(productEvents.log.mock.calls.map((c) => c[0].metadata.setupTool)).toEqual([
      undefined,
      'setup_find_connectors',
      'setup_get_status',
    ]);
  });

  it('writes nothing when another process already wrote today\'s row', async () => {
    const { productEvents, recorder } = build([{ metadata: { tool: 'anythingmcp_run_read_tool', setupTool: 'setup_find_connectors' } }]);
    await recorder.record({ ...call, tool: 'anythingmcp_run_read_tool', setupTool: 'setup_find_connectors' }, NOV_2);
    expect(productEvents.log).not.toHaveBeenCalled();
    // The same run tool without a setup tool is another row.
    await recorder.record({ ...call, tool: 'anythingmcp_run_read_tool' }, NOV_2);
    expect(productEvents.log).toHaveBeenCalledTimes(1);
  });

  it('leaves the client out when there is no OAuth client, and never throws', async () => {
    const { prisma, productEvents, recorder } = build();
    await recorder.record({ ...call, oauthClientId: undefined }, NOV_2);
    expect(prisma.oAuthClient.findUnique).not.toHaveBeenCalled();
    expect(productEvents.log.mock.calls[0][0].metadata).toEqual({ tool: 'anythingmcp_list_connectors', profile: 'default' });

    prisma.productEvent.findMany.mockRejectedValue(new Error('db down'));
    await expect(recorder.record({ ...call, tool: 'kg_how_to_obtain' }, NOV_2)).resolves.toBeUndefined();
  });

  it('bounds the in-process keys, dropping the oldest first', () => {
    const keys = new DailyKeySet(2);
    expect(keys.add('a')).toBe(true);
    expect(keys.add('b')).toBe(true);
    expect(keys.add('a')).toBe(false);
    expect(keys.add('c')).toBe(true);
    expect(keys.size).toBe(2);
    expect(keys.add('a')).toBe(true);
  });

  it('names the UTC day', () => {
    expect(utcDay(Date.UTC(2026, 10, 2, 23, 59))).toBe('2026-11-02');
  });
});
