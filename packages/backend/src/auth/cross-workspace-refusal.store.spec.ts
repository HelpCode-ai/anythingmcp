import { CrossWorkspaceRefusalStore } from './cross-workspace-refusal.store';

describe('CrossWorkspaceRefusalStore', () => {
  const TTL_MS = CrossWorkspaceRefusalStore.TTL_SECONDS * 1000;

  describe('with Redis connected', () => {
    let redis: any;
    let store: CrossWorkspaceRefusalStore;

    beforeEach(() => {
      redis = {
        isConnected: true,
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn().mockResolvedValue(undefined),
      };
      store = new CrossWorkspaceRefusalStore(redis);
    });

    it('stores the marker with a 15-minute expiry', async () => {
      await store.mark('u1', 'client-1', 'srv-B');
      expect(redis.set).toHaveBeenCalledWith('xws:u1:client-1', 'srv-B', 15 * 60);
    });

    it('reads the marker back', async () => {
      redis.get.mockResolvedValue('srv-B');
      await expect(store.peek('u1', 'client-1')).resolves.toBe('srv-B');
      expect(redis.get).toHaveBeenCalledWith('xws:u1:client-1');
    });

    it('clears the marker', async () => {
      await store.clear('u1', 'client-1');
      expect(redis.del).toHaveBeenCalledWith('xws:u1:client-1');
    });

    it('falls back to memory when Redis fails, and peek never throws', async () => {
      redis.set.mockRejectedValue(new Error('READONLY'));
      redis.get.mockRejectedValue(new Error('connection reset'));
      jest.spyOn((store as any).logger, 'warn').mockImplementation(() => undefined);
      await store.mark('u1', 'client-1', 'srv-B');
      await expect(store.peek('u1', 'client-1')).resolves.toBe('srv-B');
    });
  });

  describe('in memory (no Redis)', () => {
    it('keeps a marker for 15 minutes, then forgets it', async () => {
      const store = new CrossWorkspaceRefusalStore();
      const t0 = 1_000_000;
      await store.mark('u1', 'client-1', 'srv-B', t0);
      await expect(store.peek('u1', 'client-1', t0 + TTL_MS - 1)).resolves.toBe('srv-B');
      await expect(store.peek('u1', 'client-1', t0 + TTL_MS)).resolves.toBeNull();
    });

    it('keeps markers apart per user and per client', async () => {
      const store = new CrossWorkspaceRefusalStore();
      await store.mark('u1', 'client-1', 'srv-B');
      await expect(store.peek('u1', 'client-2')).resolves.toBeNull();
      await expect(store.peek('u2', 'client-1')).resolves.toBeNull();
      await expect(store.peek('u1', 'client-1')).resolves.toBe('srv-B');
    });

    it('works when Redis is configured but not connected', async () => {
      const redis: any = { isConnected: false, set: jest.fn(), get: jest.fn(), del: jest.fn() };
      const store = new CrossWorkspaceRefusalStore(redis);
      await store.mark('u1', 'client-1', 'srv-B');
      await expect(store.peek('u1', 'client-1')).resolves.toBe('srv-B');
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('clears a marker', async () => {
      const store = new CrossWorkspaceRefusalStore();
      await store.mark('u1', 'client-1', 'srv-B');
      await store.clear('u1', 'client-1');
      await expect(store.peek('u1', 'client-1')).resolves.toBeNull();
    });

    it('is bounded: the oldest marker goes first when full', async () => {
      const store = new CrossWorkspaceRefusalStore();
      const max = CrossWorkspaceRefusalStore.MAX_MEMORY_ENTRIES;
      const t0 = 1_000_000;
      for (let i = 0; i < max; i++) await store.mark(`u${i}`, 'c', 'srv', t0);
      await store.mark('newest', 'c', 'srv', t0);
      expect((store as any).memory.size).toBe(max);
      await expect(store.peek('u0', 'c', t0)).resolves.toBeNull();
      await expect(store.peek('u1', 'c', t0)).resolves.toBe('srv');
      await expect(store.peek('newest', 'c', t0)).resolves.toBe('srv');
    });

    it('ignores empty keys', async () => {
      const store = new CrossWorkspaceRefusalStore();
      await store.mark('', 'client-1', 'srv-B');
      await store.mark('u1', '', 'srv-B');
      expect((store as any).memory.size).toBe(0);
      await expect(store.peek('', 'client-1')).resolves.toBeNull();
    });
  });
});
