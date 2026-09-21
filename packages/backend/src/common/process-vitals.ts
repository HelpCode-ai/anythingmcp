/**
 * Process vitals: the pure parts.
 *
 * On 2026-09-20 the cloud backend died four times in one afternoon with
 *
 *   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 *
 * and nothing in our own logs said a word about it beforehand. `/health`
 * answered 200 through the whole decline, because it checked Postgres and
 * Redis and never looked at the process it was running in.
 *
 * The first version of this guard then made the next night worse. It wrote a
 * heap snapshot at 60 % of the heap, and V8 builds a snapshot entirely in
 * memory before writing a byte — for a 2.5 GB heap, roughly another 2.5 GB.
 * The container's cgroup limit was 5 GB. Nineteen times between 03:52 and
 * 06:23 the kernel killed the process mid-snapshot: nineteen empty files,
 * nineteen restarts, no log line, because the "writing a snapshot" message
 * was still in stdout's buffer when SIGKILL arrived. A crash an hour became
 * a crash every five minutes.
 *
 * Hence the shape of this file now:
 *   - the snapshot is opt-in (0 by default) and refused unless the process
 *     can show the room for it;
 *   - the guard watches RSS against the cgroup limit as well as the V8 heap
 *     against its own limit, because the kernel enforces the former and
 *     does not care about the latter;
 *   - the service leaves a beat between logging and blocking, so the log
 *     line reaches stdout before the event loop stops.
 *
 * Everything decided here is a function of numbers, so it can be tested
 * without timers, heap snapshots or signals. The service that runs the timer
 * and performs the effects is in process-vitals.service.ts.
 */
import { readFileSync } from 'node:fs';

/** What a tick sees. Bytes. `rssLimit` is undefined outside a limited cgroup. */
export interface HeapSample {
  heapUsed: number;
  heapLimit: number;
  rss?: number;
  rssLimit?: number;
}

export interface HeapPolicy {
  /** Log a warning when the heap first crosses this; 0 disables. */
  warnPercent: number;
  /** Write ONE heap snapshot per process when the heap crosses this; 0 disables. */
  snapshotPercent: number;
  /** Ask the process to exit after `exitConsecutive` ticks with the heap at or above this; 0 disables. */
  exitPercent: number;
  /** Same, for RSS against the cgroup memory limit; 0 disables. */
  rssExitPercent: number;
  /** How many consecutive ticks over a line before exiting. */
  exitConsecutive: number;
}

export interface HeapState {
  snapshotTaken: boolean;
  warned: boolean;
  overExitTicks: number;
  overRssTicks: number;
}

export type HeapAction = 'warn' | 'snapshot' | 'snapshot-skipped' | 'exit' | 'exit-rss';

export const INITIAL_HEAP_STATE: HeapState = Object.freeze({
  snapshotTaken: false,
  warned: false,
  overExitTicks: 0,
  overRssTicks: 0,
});

/**
 * A heap snapshot needs about as much memory again as the heap it describes,
 * held while it is built. The snapshot is refused unless the process would
 * still sit under this fraction of its cgroup limit with that added on.
 */
export const SNAPSHOT_HEADROOM_FRACTION = 0.85;

export function heapPercent(sample: HeapSample): number {
  if (!(sample.heapLimit > 0)) return 0;
  return (sample.heapUsed / sample.heapLimit) * 100;
}

export function rssPercent(sample: HeapSample): number | undefined {
  if (!sample.rss || !sample.rssLimit || !(sample.rssLimit > 0)) return undefined;
  return (sample.rss / sample.rssLimit) * 100;
}

/**
 * Decide what a tick should do. Returns the actions and the next state; the
 * caller performs the actions in the order given.
 *
 * - `warn` fires once when crossing warnPercent and re-arms only after the
 *   heap drops 10 points below it, so a process hovering at the line does not
 *   write the same warning every 30 seconds.
 * - `snapshot` fires at most once per process, and only if the process can
 *   show room for it (see SNAPSHOT_HEADROOM_FRACTION). Otherwise
 *   `snapshot-skipped` fires once instead, so the refusal is in the log. A
 *   snapshot without the room for it is not a diagnostic; it is the outage.
 * - `exit` / `exit-rss` need `exitConsecutive` ticks in a row over their
 *   line. A single GC spike must not restart a healthy process; a sustained
 *   climb must. RSS is judged against the cgroup limit because that is what
 *   the kernel kills on, and it can be reached with the V8 heap well under
 *   its own limit — native buffers and the snapshot builder both live
 *   outside the heap.
 */
export function evaluateHeap(
  sample: HeapSample,
  policy: HeapPolicy,
  state: HeapState,
): { actions: HeapAction[]; state: HeapState; percent: number; rssPct?: number } {
  const percent = heapPercent(sample);
  const rssPct = rssPercent(sample);
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
    next.snapshotTaken = true;
    const roomKnown = sample.rss !== undefined && sample.rssLimit !== undefined && sample.rssLimit > 0;
    const fits = !roomKnown || sample.rss! + sample.heapUsed <= sample.rssLimit! * SNAPSHOT_HEADROOM_FRACTION;
    actions.push(fits ? 'snapshot' : 'snapshot-skipped');
  }

  const consecutive = Math.max(1, policy.exitConsecutive);

  if (policy.exitPercent > 0) {
    if (percent >= policy.exitPercent) {
      next.overExitTicks += 1;
      if (next.overExitTicks >= consecutive) actions.push('exit');
    } else {
      next.overExitTicks = 0;
    }
  }

  if (policy.rssExitPercent > 0 && rssPct !== undefined) {
    if (rssPct >= policy.rssExitPercent) {
      next.overRssTicks += 1;
      if (next.overRssTicks >= consecutive) actions.push('exit-rss');
    } else {
      next.overRssTicks = 0;
    }
  }

  return { actions, state: next, percent, rssPct };
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
    // Off by default. See the header: on a large heap the snapshot builder
    // is what pushes the process into the cgroup limit.
    snapshotPercent: intEnv(env, 'HEAP_SNAPSHOT_PERCENT', 0),
    exitPercent: intEnv(env, 'HEAP_EXIT_PERCENT', 90),
    rssExitPercent: intEnv(env, 'HEAP_RSS_EXIT_PERCENT', 90),
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

/** Percent of the heap (or RSS) limit at which /health reports the process down; 0 disables. */
export function readHealthHeapPercent(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, 'HEALTH_HEAP_PERCENT', 90);
}

/**
 * The memory limit the kernel will enforce on this process, in bytes, or
 * undefined when there is none (not in a container, or an unlimited cgroup).
 * cgroup v2 first, v1 as a fallback; v1 reports "no limit" as a huge number.
 */
export function readCgroupMemoryLimit(
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): number | undefined {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFile(path).trim();
      if (raw === 'max') return undefined;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return n;
    } catch {
      // not there — try the next, or give up
    }
  }
  return undefined;
}

export interface HeapStatus {
  status: 'up' | 'down';
  usedMb: number;
  limitMb: number;
  percent: number;
  rssMb?: number;
  rssLimitMb?: number;
  rssPercent?: number;
}

/** What /health reports. Numbers are included even when up. */
export function heapStatus(sample: HeapSample, failPercent: number): HeapStatus {
  const percent = Math.round(heapPercent(sample) * 10) / 10;
  const rp = rssPercent(sample);
  const overHeap = failPercent > 0 && percent >= failPercent;
  const overRss = failPercent > 0 && rp !== undefined && rp >= failPercent;
  const out: HeapStatus = {
    status: overHeap || overRss ? 'down' : 'up',
    usedMb: Math.round(sample.heapUsed / 1048576),
    limitMb: Math.round(sample.heapLimit / 1048576),
    percent,
  };
  if (sample.rss !== undefined) out.rssMb = Math.round(sample.rss / 1048576);
  if (sample.rssLimit !== undefined) out.rssLimitMb = Math.round(sample.rssLimit / 1048576);
  if (rp !== undefined) out.rssPercent = Math.round(rp * 10) / 10;
  return out;
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
