import {
  evaluateHeap,
  heapStatus,
  HeapPolicy,
  INITIAL_HEAP_STATE,
  ProcessGauges,
  readCgroupMemoryLimit,
  readHeapPolicy,
  readHealthHeapPercent,
  readVitalsIntervalSec,
} from './process-vitals';
import { ProcessVitalsService } from './process-vitals.service';

const GB = 1024 * 1024 * 1024;
const policy: HeapPolicy = {
  warnPercent: 75,
  snapshotPercent: 60,
  exitPercent: 90,
  rssExitPercent: 90,
  exitConsecutive: 3,
};
/** A sample at N% of a 4 GB heap, with no cgroup limit known. */
const at = (percent: number) => ({ heapUsed: (percent / 100) * 4 * GB, heapLimit: 4 * GB });
/** The 21 Sep shape: heap at N% of 4 GB, rss = heap + 1.6 GB, cgroup limit 5 GB. */
const night = (percent: number) => ({
  heapUsed: (percent / 100) * 4 * GB,
  heapLimit: 4 * GB,
  rss: (percent / 100) * 4 * GB + 1.6 * GB,
  rssLimit: 5 * GB,
});

describe('evaluateHeap', () => {
  it('does nothing below every threshold', () => {
    const r = evaluateHeap(at(17), policy, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual([]);
    expect(r.percent).toBeCloseTo(17);
    expect(r.rssPct).toBeUndefined();
    expect(r.state).toEqual(INITIAL_HEAP_STATE);
  });

  // Warn-only policy: 76% also crosses the snapshot line, and that is tested
  // on its own below.
  const warnOnly: HeapPolicy = { ...policy, snapshotPercent: 0 };

  it('warns once, and does not repeat while hovering at the line', () => {
    let r = evaluateHeap(at(76), warnOnly, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual(['warn']);
    r = evaluateHeap(at(77), warnOnly, r.state);
    expect(r.actions).toEqual([]);
    r = evaluateHeap(at(74), warnOnly, r.state);
    expect(r.actions).toEqual([]); // still inside the hysteresis band
  });

  it('re-arms the warning only after dropping ten points below it', () => {
    let r = evaluateHeap(at(80), warnOnly, INITIAL_HEAP_STATE);
    r = evaluateHeap(at(64), warnOnly, r.state); // 75 - 10 = 65 → below → re-armed
    r = evaluateHeap(at(78), warnOnly, r.state);
    expect(r.actions).toEqual(['warn']);
  });

  it('snapshots exactly once per process when there is no cgroup limit to worry about', () => {
    let r = evaluateHeap(at(61), policy, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual(['snapshot']);
    for (let i = 0; i < 5; i++) {
      r = evaluateHeap(at(70 + i), policy, r.state);
      expect(r.actions).not.toContain('snapshot');
    }
    r = evaluateHeap(at(20), policy, r.state);
    r = evaluateHeap(at(65), policy, r.state);
    expect(r.actions).not.toContain('snapshot');
  });

  it('refuses the snapshot, once, when the process cannot show the room for it — the 21 Sep shape', () => {
    // heap 2.4 GB, rss 4.0 GB, limit 5 GB: building the snapshot needs ~2.4 GB
    // more, and 4.0 + 2.4 > 5 × 0.85. This is what killed the process 19 times.
    let r = evaluateHeap(night(60), policy, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual(['snapshot-skipped']);
    expect(r.state.snapshotTaken).toBe(true);
    r = evaluateHeap(night(61), policy, r.state);
    expect(r.actions).not.toContain('snapshot-skipped');
    expect(r.actions).not.toContain('snapshot');
  });

  it('allows the snapshot when the room is there', () => {
    // heap 0.8 GB, rss 1.0 GB, limit 6 GB: 1.0 + 0.8 is well under 6 × 0.85.
    const r = evaluateHeap(
      { heapUsed: 0.8 * GB, heapLimit: 4 * GB, rss: 1.0 * GB, rssLimit: 6 * GB },
      { ...policy, snapshotPercent: 15 },
      INITIAL_HEAP_STATE,
    );
    expect(r.actions).toEqual(['snapshot']);
  });

  it('exits on the heap only after the configured number of consecutive ticks', () => {
    let r = evaluateHeap(at(91), policy, INITIAL_HEAP_STATE);
    expect(r.actions).not.toContain('exit');
    r = evaluateHeap(at(92), policy, r.state);
    expect(r.actions).not.toContain('exit');
    r = evaluateHeap(at(93), policy, r.state);
    expect(r.actions).toContain('exit');
  });

  it('exits on RSS against the cgroup limit even with the heap well under its own — what the kernel enforces', () => {
    // heap 68% (2.7 GB) but rss 4.35 GB of 5 GB = 87%; then 4.6 GB = 92%.
    let r = evaluateHeap(night(68), { ...policy, snapshotPercent: 0 }, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual([]);
    const over = { ...night(75), rss: 4.6 * GB }; // 92% of the cgroup limit, heap only 75%
    r = evaluateHeap(over, { ...policy, snapshotPercent: 0, warnPercent: 0 }, r.state);
    r = evaluateHeap(over, { ...policy, snapshotPercent: 0, warnPercent: 0 }, r.state);
    expect(r.actions).not.toContain('exit-rss');
    r = evaluateHeap(over, { ...policy, snapshotPercent: 0, warnPercent: 0 }, r.state);
    expect(r.actions).toEqual(['exit-rss']);
    expect(r.rssPct).toBeCloseTo(92);
  });

  it('a single dip below the exit line resets the count — one GC spike must not restart a healthy process', () => {
    let r = evaluateHeap(at(91), policy, INITIAL_HEAP_STATE);
    r = evaluateHeap(at(92), policy, r.state);
    r = evaluateHeap(at(88), policy, r.state); // dip
    r = evaluateHeap(at(95), policy, r.state);
    r = evaluateHeap(at(95), policy, r.state);
    expect(r.actions).not.toContain('exit');
    r = evaluateHeap(at(95), policy, r.state);
    expect(r.actions).toContain('exit');
  });

  it('a sudden jump can warn, snapshot and count towards exit in the same tick, in that order', () => {
    const r = evaluateHeap(at(95), { ...policy, exitConsecutive: 1 }, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual(['warn', 'snapshot', 'exit']);
  });

  it('a threshold of 0 disables that action', () => {
    const off: HeapPolicy = { warnPercent: 0, snapshotPercent: 0, exitPercent: 0, rssExitPercent: 0, exitConsecutive: 1 };
    const r = evaluateHeap({ ...night(99), rss: 4.99 * GB }, off, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual([]);
  });

  it('treats an unknown heap limit as 0% rather than dividing by zero', () => {
    const r = evaluateHeap({ heapUsed: 1e9, heapLimit: 0 }, policy, INITIAL_HEAP_STATE);
    expect(r.percent).toBe(0);
    expect(r.actions).toEqual([]);
  });
});

describe('heapStatus', () => {
  it('is up with numbers below the line, and reports rss when it knows it', () => {
    expect(heapStatus(at(17), 90)).toEqual({ status: 'up', usedMb: 696, limitMb: 4096, percent: 17 });
    expect(heapStatus(night(17), 90)).toMatchObject({ status: 'up', rssMb: 2335, rssLimitMb: 5120, rssPercent: 45.6 });
  });
  it('is down at the heap line', () => {
    expect(heapStatus(at(90), 90).status).toBe('down');
  });
  it('is down at the rss line even with the heap fine', () => {
    expect(heapStatus({ ...night(50), rss: 4.6 * GB }, 90).status).toBe('down');
  });
  it('never goes down when disabled', () => {
    expect(heapStatus({ ...night(99), rss: 4.99 * GB }, 0).status).toBe('up');
  });
});

describe('env parsing', () => {
  it('uses the documented defaults — and the snapshot is OFF by default', () => {
    expect(readHeapPolicy({})).toEqual({
      warnPercent: 75,
      snapshotPercent: 0,
      exitPercent: 90,
      rssExitPercent: 90,
      exitConsecutive: 3,
    });
    expect(readVitalsIntervalSec({})).toBe(30);
    expect(readHealthHeapPercent({})).toBe(90);
  });
  it('reads overrides and ignores garbage', () => {
    expect(
      readHeapPolicy({ HEAP_EXIT_PERCENT: '85', HEAP_SNAPSHOT_PERCENT: 'x', HEAP_WARN_PERCENT: '-3', HEAP_RSS_EXIT_PERCENT: '80' }),
    ).toEqual({ warnPercent: 75, snapshotPercent: 0, exitPercent: 85, rssExitPercent: 80, exitConsecutive: 3 });
    expect(readVitalsIntervalSec({ VITALS_INTERVAL_SEC: '0' })).toBe(0);
  });
});

describe('readCgroupMemoryLimit', () => {
  const files = (map: Record<string, string>) => (p: string) => {
    if (p in map) return map[p];
    throw new Error('ENOENT');
  };
  it('reads cgroup v2', () => {
    expect(readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '6442450944\n' }))).toBe(6442450944);
  });
  it('treats v2 "max" as no limit', () => {
    expect(readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeUndefined();
  });
  it('falls back to v1 and treats its huge sentinel as no limit', () => {
    expect(readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '5368709120' }))).toBe(5368709120);
    expect(readCgroupMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }))).toBeUndefined();
  });
  it('is undefined outside a cgroup', () => {
    expect(readCgroupMemoryLimit(files({}))).toBeUndefined();
  });
});

describe('ProcessGauges', () => {
  it('counts, clamps at zero, and evaluates providers on snapshot', () => {
    const g = new ProcessGauges();
    g.inc('a');
    g.inc('a');
    g.dec('a');
    g.dec('b'); // never seen → stays 0, not -1
    g.register('tools', () => 42);
    g.register('broken', () => {
      throw new Error('x');
    });
    expect(g.snapshot()).toEqual({ a: 1, b: 0, tools: 42, broken: -1 });
  });
});

describe('ProcessVitalsService.tick', () => {
  function service(samples: Array<{ heapPct: number; rss?: number }>, overrides: Partial<HeapPolicy> = {}) {
    const svc = new ProcessVitalsService();
    svc.policy = { ...policy, exitConsecutive: 2, ...overrides };
    svc.snapshotDir = '/nowhere';
    let i = 0;
    svc.collector = {
      memory: () => {
        const s = samples[Math.min(i++, samples.length - 1)];
        const heapUsed = (s.heapPct / 100) * 4 * GB;
        return { rss: s.rss ?? heapUsed * 1.2, heapUsed, heapTotal: heapUsed * 1.05, external: 1e6, arrayBuffers: 1e5 } as NodeJS.MemoryUsage;
      },
      heapLimit: () => 4 * GB,
      rssLimit: () => 6 * GB,
      activeResources: () => ['TCPSocketWrap', 'TCPSocketWrap', 'Timeout'],
    };
    const effects = {
      writeSnapshot: jest.fn(() => ({ path: '/nowhere/x', bytes: 10, ms: 1 })),
      requestExit: jest.fn(),
      pause: jest.fn(async () => undefined),
    };
    svc.effects = effects;
    const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (svc as any).logger = log;
    (svc as any).rssLimit = 6 * GB; // what onModuleInit would have read
    return { svc, effects, log };
  }

  it('logs one structured vitals line per tick with rss, cgroup limit and gauges attached', async () => {
    const { svc, log } = service([{ heapPct: 17 }]);
    await svc.tick();
    expect(log.log).toHaveBeenCalledTimes(1);
    const line = log.log.mock.calls[0][0];
    expect(line.msg).toBe('vitals');
    expect(line.vitals.heapPercent).toBe(17);
    expect(line.vitals.heapLimitMb).toBe(4096);
    expect(line.vitals.rssLimitMb).toBe(6144);
    expect(typeof line.vitals.rssPercent).toBe('number');
    expect(line.vitals.activeByType).toEqual({ TCPSocketWrap: 2, Timeout: 1 });
    expect(typeof line.vitals.gauges).toBe('object');
  });

  it('pauses to flush the log before writing the snapshot, writes once, and requests exit once', async () => {
    // Snapshot enabled at 60 with plenty of room (rss 1.2×heap of a 6 GB limit).
    const { svc, effects } = service([{ heapPct: 65 }, { heapPct: 92 }, { heapPct: 93 }, { heapPct: 94 }, { heapPct: 95 }]);
    for (let i = 0; i < 5; i++) await svc.tick();
    expect(effects.pause).toHaveBeenCalledWith(300);
    expect(effects.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(effects.writeSnapshot).toHaveBeenCalledWith('/nowhere');
    expect(effects.requestExit).toHaveBeenCalledTimes(1);
  });

  it('refuses the snapshot when rss leaves no room, and says so instead of dying', async () => {
    // heap 2.6 GB (65%), rss 4.5 GB of a 6 GB limit: 4.5 + 2.6 > 6 × 0.85.
    const { svc, effects, log } = service([{ heapPct: 65, rss: 4.5 * GB }]);
    await svc.tick();
    expect(effects.writeSnapshot).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('leaves no room'));
  });

  it('exits on rss pressure with the heap under its own line', async () => {
    const hot = { heapPct: 60, rss: 5.6 * GB }; // 93% of 6 GB
    const { svc, effects, log } = service([hot, hot, hot], { snapshotPercent: 0 });
    for (let i = 0; i < 3; i++) await svc.tick();
    expect(effects.requestExit).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('rss over 90%'));
  });

  it('survives a failing snapshot and keeps logging', async () => {
    const { svc, effects, log } = service([{ heapPct: 65 }, { heapPct: 66 }]);
    effects.writeSnapshot.mockImplementation(() => {
      throw new Error('disk full');
    });
    await svc.tick();
    await svc.tick();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(log.log).toHaveBeenCalledTimes(2);
  });
});
