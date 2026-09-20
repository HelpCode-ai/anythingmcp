import {
  evaluateHeap,
  heapStatus,
  HeapPolicy,
  INITIAL_HEAP_STATE,
  ProcessGauges,
  readHeapPolicy,
  readHealthHeapPercent,
  readVitalsIntervalSec,
} from './process-vitals';
import { ProcessVitalsService } from './process-vitals.service';

const GB = 1024 * 1024 * 1024;
const policy: HeapPolicy = { warnPercent: 75, snapshotPercent: 60, exitPercent: 90, exitConsecutive: 3 };
const at = (percent: number) => ({ heapUsed: (percent / 100) * 4 * GB, heapLimit: 4 * GB });

describe('evaluateHeap', () => {
  it('does nothing below every threshold', () => {
    const r = evaluateHeap(at(17), policy, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual([]);
    expect(r.percent).toBeCloseTo(17);
    expect(r.state).toEqual(INITIAL_HEAP_STATE);
  });

  // Warn-only policy: 76% also crosses the snapshot line, and that is tested
  // on its own below.
  const warnOnly: HeapPolicy = { ...policy, snapshotPercent: 0 };

  it('warns once, and does not repeat while hovering at the line', () => {
    let s = INITIAL_HEAP_STATE;
    let r = evaluateHeap(at(76), warnOnly, s);
    expect(r.actions).toEqual(['warn']);
    s = r.state;
    r = evaluateHeap(at(77), warnOnly, s);
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

  it('snapshots exactly once per process, no matter how long it stays high', () => {
    let r = evaluateHeap(at(61), policy, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual(['snapshot']);
    for (let i = 0; i < 5; i++) {
      r = evaluateHeap(at(70 + i), policy, r.state);
      expect(r.actions).not.toContain('snapshot');
    }
    // Even after dropping and climbing again: the snapshot is the diagnostic,
    // a second one is an outage.
    r = evaluateHeap(at(20), policy, r.state);
    r = evaluateHeap(at(65), policy, r.state);
    expect(r.actions).not.toContain('snapshot');
  });

  it('exits only after the configured number of consecutive ticks', () => {
    let r = evaluateHeap(at(91), policy, INITIAL_HEAP_STATE);
    expect(r.actions).not.toContain('exit');
    r = evaluateHeap(at(92), policy, r.state);
    expect(r.actions).not.toContain('exit');
    r = evaluateHeap(at(93), policy, r.state);
    expect(r.actions).toContain('exit');
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
    const off: HeapPolicy = { warnPercent: 0, snapshotPercent: 0, exitPercent: 0, exitConsecutive: 1 };
    const r = evaluateHeap(at(99), off, INITIAL_HEAP_STATE);
    expect(r.actions).toEqual([]);
  });

  it('treats an unknown heap limit as 0% rather than dividing by zero', () => {
    const r = evaluateHeap({ heapUsed: 1e9, heapLimit: 0 }, policy, INITIAL_HEAP_STATE);
    expect(r.percent).toBe(0);
    expect(r.actions).toEqual([]);
  });
});

describe('heapStatus', () => {
  it('is up with numbers below the line', () => {
    expect(heapStatus(at(17), 90)).toEqual({ status: 'up', usedMb: 696, limitMb: 4096, percent: 17 });
  });
  it('is down at the line', () => {
    expect(heapStatus(at(90), 90).status).toBe('down');
  });
  it('never goes down when disabled', () => {
    expect(heapStatus(at(99), 0).status).toBe('up');
  });
});

describe('env parsing', () => {
  it('uses the documented defaults', () => {
    expect(readHeapPolicy({})).toEqual({ warnPercent: 75, snapshotPercent: 60, exitPercent: 90, exitConsecutive: 3 });
    expect(readVitalsIntervalSec({})).toBe(30);
    expect(readHealthHeapPercent({})).toBe(90);
  });
  it('reads overrides and ignores garbage', () => {
    expect(readHeapPolicy({ HEAP_EXIT_PERCENT: '85', HEAP_SNAPSHOT_PERCENT: 'x', HEAP_WARN_PERCENT: '-3' })).toEqual({
      warnPercent: 75,
      snapshotPercent: 60,
      exitPercent: 85,
      exitConsecutive: 3,
    });
    expect(readVitalsIntervalSec({ VITALS_INTERVAL_SEC: '0' })).toBe(0);
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
  function service(percents: number[]) {
    const svc = new ProcessVitalsService();
    svc.policy = { ...policy, exitConsecutive: 2 };
    svc.snapshotDir = '/nowhere';
    let i = 0;
    svc.collector = {
      memory: () => {
        const p = percents[Math.min(i++, percents.length - 1)];
        const heapUsed = (p / 100) * 4 * GB;
        return { rss: heapUsed * 1.2, heapUsed, heapTotal: heapUsed * 1.05, external: 1e6, arrayBuffers: 1e5 } as NodeJS.MemoryUsage;
      },
      heapLimit: () => 4 * GB,
      activeResources: () => ['TCPSocketWrap', 'TCPSocketWrap', 'Timeout'],
    };
    const effects = { writeSnapshot: jest.fn(() => ({ path: '/nowhere/x', bytes: 10, ms: 1 })), requestExit: jest.fn() };
    svc.effects = effects;
    const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (svc as any).logger = log;
    return { svc, effects, log };
  }

  it('logs one structured vitals line per tick with the gauges attached', () => {
    const { svc, log } = service([17]);
    svc.tick();
    expect(log.log).toHaveBeenCalledTimes(1);
    const line = log.log.mock.calls[0][0];
    expect(line.msg).toBe('vitals');
    expect(line.vitals.heapPercent).toBe(17);
    expect(line.vitals.heapLimitMb).toBe(4096);
    expect(line.vitals.activeResources).toBe(3);
    expect(line.vitals.activeByType).toEqual({ TCPSocketWrap: 2, Timeout: 1 });
    expect(typeof line.vitals.gauges).toBe('object');
  });

  it('writes the snapshot once and requests exit once, through the effects, not the world', () => {
    const { svc, effects } = service([65, 92, 93, 94, 95]);
    for (let i = 0; i < 5; i++) svc.tick();
    expect(effects.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(effects.writeSnapshot).toHaveBeenCalledWith('/nowhere');
    // ticks 2 and 3 are the two consecutive over-90 ticks → exit at tick 3;
    // ticks 4 and 5 must not ask again.
    expect(effects.requestExit).toHaveBeenCalledTimes(1);
  });

  it('survives a failing snapshot and keeps logging', () => {
    const { svc, effects, log } = service([65, 66]);
    effects.writeSnapshot.mockImplementation(() => {
      throw new Error('disk full');
    });
    svc.tick();
    svc.tick();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(log.log).toHaveBeenCalledTimes(2);
  });
});
