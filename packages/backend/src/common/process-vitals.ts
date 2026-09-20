/**
 * Process vitals: the pure parts.
 *
 * On 2026-09-20 the cloud backend died four times in one afternoon with
 *
 *   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 *
 * and nothing in our own logs said a word about it beforehand. `/health`
 * answered 200 through the whole decline, because it checked Postgres and
 * Redis and never looked at the process it was running in. The last minutes
 * before each crash were spent in 8-second garbage-collection pauses that
 * recovered nothing (`average mu = 0.001`) — the process was already useless
 * to callers, and still reporting healthy.
 *
 * Everything decided here is a function of numbers, so it can be tested
 * without timers, heap snapshots or signals. The service that runs the timer
 * and performs the effects is in process-vitals.service.ts.
 */

/** What a tick sees. Bytes, straight from process.memoryUsage / v8. */
export interface HeapSample {
  heapUsed: number;
  heapLimit: number;
}

export interface HeapPolicy {
  /** Log a warning when the heap first crosses this; 0 disables. */
  warnPercent: number;
  /** Write ONE heap snapshot per process when the heap crosses this; 0 disables. */
  snapshotPercent: number;
  /** Ask the process to exit after `exitConsecutive` ticks at or above this; 0 disables. */
  exitPercent: number;
  /** How many consecutive ticks over exitPercent before exiting. */
  exitConsecutive: number;
}

export interface HeapState {
  snapshotTaken: boolean;
  warned: boolean;
  overExitTicks: number;
}

export type HeapAction = 'warn' | 'snapshot' | 'exit';

export const INITIAL_HEAP_STATE: HeapState = Object.freeze({
  snapshotTaken: false,
  warned: false,
  overExitTicks: 0,
});

export function heapPercent(sample: HeapSample): number {
  if (!(sample.heapLimit > 0)) return 0;
  return (sample.heapUsed / sample.heapLimit) * 100;
}

/**
 * Decide what a tick should do. Returns the actions and the next state; the
 * caller performs the actions in the order given.
 *
 * - `warn` fires once when crossing warnPercent and re-arms only after the
 *   heap drops 10 points below it, so a process hovering at the line does not
 *   write the same warning every 30 seconds.
 * - `snapshot` fires at most once per process. A snapshot blocks the event
 *   loop for seconds on a multi-gigabyte heap; one is the diagnostic, two is
 *   an outage.
 * - `exit` needs `exitConsecutive` ticks in a row over the line. A single GC
 *   spike must not restart a healthy process; a sustained climb must.
 */
export function evaluateHeap(
  sample: HeapSample,
  policy: HeapPolicy,
  state: HeapState,
): { actions: HeapAction[]; state: HeapState; percent: number } {
  const percent = heapPercent(sample);
  const actions: HeapAction[] = [];
  const next: HeapState = { ...state };

  if (policy.warnPercent > 0) {
    if (percent >= policy.warnPercent && !next.warned) {
      actions.push('warn');
      next.warned = true;
    } else if (percent < policy.warnPercent - 10) {
      next.warned = false;
    }
  }

  if (policy.snapshotPercent > 0 && percent >= policy.snapshotPercent && !next.snapshotTaken) {
    actions.push('snapshot');
    next.snapshotTaken = true;
  }

  if (policy.exitPercent > 0) {
    if (percent >= policy.exitPercent) {
      next.overExitTicks += 1;
      if (next.overExitTicks >= Math.max(1, policy.exitConsecutive)) {
        actions.push('exit');
      }
    } else {
      next.overExitTicks = 0;
    }
  }

  return { actions, state: next, percent };
}

/** One integer env var, with a default and a floor of 0. */
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function readHeapPolicy(env: NodeJS.ProcessEnv = process.env): HeapPolicy {
  return {
    warnPercent: intEnv(env, 'HEAP_WARN_PERCENT', 75),
    snapshotPercent: intEnv(env, 'HEAP_SNAPSHOT_PERCENT', 60),
    exitPercent: intEnv(env, 'HEAP_EXIT_PERCENT', 90),
    exitConsecutive: intEnv(env, 'HEAP_EXIT_CONSECUTIVE', 3),
  };
}

/** Seconds between vitals ticks; 0 turns the whole thing off. */
export function readVitalsIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'VITALS_INTERVAL_SEC', 30);
}

export function readSnapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEAP_SNAPSHOT_DIR || '/tmp/anythingmcp-diagnostics';
}

/** Percent of the heap limit at which /health reports the process down; 0 disables. */
export function readHealthHeapPercent(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'HEALTH_HEAP_PERCENT', 90);
}

export interface HeapStatus {
  status: 'up' | 'down';
  usedMb: number;
  limitMb: number;
  percent: number;
}

/** What /health reports for the heap. Numbers are included even when up. */
export function heapStatus(sample: HeapSample, failPercent: number): HeapStatus {
  const percent = Math.round(heapPercent(sample) * 10) / 10;
  return {
    status: failPercent > 0 && percent >= failPercent ? 'down' : 'up',
    usedMb: Math.round(sample.heapUsed / 1048576),
    limitMb: Math.round(sample.heapLimit / 1048576),
    percent,
  };
}

/**
 * Live counters, deliberately free of any Nest dependency so a module can
 * bump them without importing another module. Counters are incremented and
 * decremented by the code that owns the resource; providers are callbacks for
 * numbers that already exist somewhere (registry size, session count).
 */
export class ProcessGauges {
  private readonly counters = new Map<string, number>();
  private readonly providers = new Map<string, () => number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Never goes below zero: a stray double-decrement must not read as a leak. */
  dec(name: string, by = 1): void {
    this.counters.set(name, Math.max(0, (this.counters.get(name) ?? 0) - by));
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  register(name: string, provider: () => number): void {
    this.providers.set(name, provider);
  }

  /** Every counter and every provider, providers evaluated now. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    for (const [k, fn] of this.providers) {
      try {
        out[k] = fn();
      } catch {
        out[k] = -1;
      }
    }
    return out;
  }

  /** Test helper. */
  reset(): void {
    this.counters.clear();
    this.providers.clear();
  }
}

export const processGauges = new ProcessGauges();
