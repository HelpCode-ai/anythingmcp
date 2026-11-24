import { McpSessionManager, McpSessionEntry } from './mcp-session.manager';

/**
 * Unit coverage for the stateful MCP session lifecycle: cap eviction, close,
 * and broad rebuild fan-out. Transport/server are stubbed.
 */
describe('McpSessionManager', () => {
  const makeEntry = (id: string, over: Partial<McpSessionEntry> = {}): McpSessionEntry => ({
    sessionId: id,
    serverId: 'srv',
    organizationId: 'org',
    principalKey: 'sub:u',
    transport: { close: jest.fn().mockResolvedValue(undefined) } as any,
    mcpServer: { close: jest.fn().mockResolvedValue(undefined) } as any,
    handles: new Map(),
    signature: '',
    rebuild: jest.fn().mockResolvedValue(undefined),
    lastActivity: Date.now(),
    ...over,
  });

  afterEach(() => {
    delete process.env.MCP_STATEFUL_SESSIONS;
    delete process.env.MCP_MAX_SESSIONS;
  });

  it('isEnabled reflects the env flag', () => {
    expect(McpSessionManager.isEnabled()).toBe(false);
    process.env.MCP_STATEFUL_SESSIONS = 'true';
    expect(McpSessionManager.isEnabled()).toBe(true);
  });

  it('stores and retrieves a session, and touch updates activity', () => {
    const mgr = new McpSessionManager();
    const e = makeEntry('a', { lastActivity: 1 });
    mgr.add(e);
    expect(mgr.get('a')).toBe(e);
    mgr.touch('a', 999);
    expect(mgr.get('a')!.lastActivity).toBe(999);
  });

  it('remove() closes the transport and server and forgets the session', async () => {
    const mgr = new McpSessionManager();
    const e = makeEntry('a');
    mgr.add(e);
    await mgr.remove('a');
    expect(e.transport.close).toHaveBeenCalled();
    expect(e.mcpServer.close).toHaveBeenCalled();
    expect(mgr.get('a')).toBeUndefined();
    await expect(mgr.remove('a')).resolves.toBeUndefined(); // idempotent
  });

  it('evicts the least-recently-active session when the cap is reached', () => {
    process.env.MCP_MAX_SESSIONS = '2';
    const mgr = new McpSessionManager();
    const old = makeEntry('old', { lastActivity: 1 });
    const mid = makeEntry('mid', { lastActivity: 5 });
    mgr.add(old);
    mgr.add(mid);
    mgr.add(makeEntry('new', { lastActivity: 9 })); // triggers eviction
    expect(mgr.get('old')).toBeUndefined(); // oldest evicted
    expect(mgr.get('mid')).toBeDefined();
    expect(mgr.get('new')).toBeDefined();
  });

  it('notifyToolsChanged() invokes rebuild on every session and survives a failure', async () => {
    const mgr = new McpSessionManager();
    const good = makeEntry('good');
    const bad = makeEntry('bad', {
      rebuild: jest.fn().mockRejectedValue(new Error('boom')),
    });
    mgr.add(good);
    mgr.add(bad);
    await expect(mgr.notifyToolsChanged()).resolves.toBeUndefined();
    expect(good.rebuild).toHaveBeenCalled();
    expect(bad.rebuild).toHaveBeenCalled();
  });

  it('notifyToolsChanged(serverIds) rebuilds only the sessions on those servers', async () => {
    const mgr = new McpSessionManager();
    const onA = makeEntry('a1', { serverId: 'srv-a' });
    const onA2 = makeEntry('a2', { serverId: 'srv-a' });
    const onB = makeEntry('b1', { serverId: 'srv-b' });
    mgr.add(onA);
    mgr.add(onA2);
    mgr.add(onB);
    await mgr.notifyToolsChanged(['srv-a', 'srv-a', 'srv-unknown']);
    expect(onA.rebuild).toHaveBeenCalledTimes(1);
    expect(onA2.rebuild).toHaveBeenCalledTimes(1);
    expect(onB.rebuild).not.toHaveBeenCalled();

    await mgr.notifyToolsChanged([]);
    expect(onB.rebuild).not.toHaveBeenCalled();
    expect(mgr.hasSessions()).toBe(true);
  });
});
