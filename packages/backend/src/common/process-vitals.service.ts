import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';
import * as v8 from 'node:v8';
import {
  evaluateHeap,
  HeapPolicy,
  HeapSample,
  HeapState,
  INITIAL_HEAP_STATE,
  processGauges,
  readHeapPolicy,
  readSnapshotDir,
  readVitalsIntervalSec,
} from './process-vitals';

/** What a tick reads. Overridable so tests can feed numbers. */
export interface VitalsCollector {
  memory(): NodeJS.MemoryUsage;
  heapLimit(): number;
  activeResources(): string[];
}

/** What a tick may do. Overridable so tests never write a snapshot or send a signal. */
export interface VitalsEffects {
  writeSnapshot(dir: string): { path: string; bytes: number; ms: number };
  requestExit(): void;
}

const defaultCollector: VitalsCollector = {
  memory: () => process.memoryUsage(),
  heapLimit: () => v8.getHeapStatistics().heap_size_limit,
  activeResources: () => process.getActiveResourcesInfo(),
};

const defaultEffects: VitalsEffects = {
  writeSnapshot(dir) {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `heap-${stamp}-${process.pid}.heapsnapshot`);
    const t0 = Date.now();
    v8.writeHeapSnapshot(path);
    return { path, bytes: statSync(path).size, ms: Date.now() - t0 };
  },
  requestExit() {
    // SIGTERM takes the same path as `docker stop`: Nest drains in-flight
    // requests and closes Postgres/Redis before exiting. If that hangs — it
    // is a process short of memory — the fallback ends it anyway.
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.exit(70), 30_000).unref();
  },
};

const MB = 1048576;
const mb = (n: number) => Math.round((n / MB) * 10) / 10;

/**
 * Logs one `vitals` line per interval and acts on heap pressure.
 *
 * Why this exists is in process-vitals.ts. What it does each tick:
 *
 *   1. read memory, heap limit, event-loop delay, active handles and the live
 *      gauges other modules maintain;
 *   2. log them as one structured line, so the trend before any incident is
 *      in the log rather than reconstructed from `docker stats` afterwards;
 *   3. warn once when the heap crosses HEAP_WARN_PERCENT;
 *   4. write one heap snapshot per process at HEAP_SNAPSHOT_PERCENT — the
 *      only artifact that names which objects are being retained;
 *   5. after HEAP_EXIT_CONSECUTIVE ticks over HEAP_EXIT_PERCENT, exit
 *      gracefully. The alternative is what happened on 20 Sep: minutes of
 *      stop-the-world GC serving nothing, then a hard abort.
 *
 * A separate process supervisor turns that exit into a restart. Whether that
 * restart takes the frontend down with it is the supervisor's business, not
 * this service's.
 */
@Injectable()
export class ProcessVitalsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessVitalsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private loopDelay?: IntervalHistogram;
  private state: HeapState = { ...INITIAL_HEAP_STATE };
  private exitRequested = false;

  /** Public so tests (and only tests) can swap the world out. */
  collector: VitalsCollector = defaultCollector;
  effects: VitalsEffects = defaultEffects;
  policy: HeapPolicy = readHeapPolicy();
  snapshotDir = readSnapshotDir();

  onModuleInit(): void {
    const intervalSec = readVitalsIntervalSec();
    if (intervalSec === 0) {
      this.logger.log('Process vitals disabled (VITALS_INTERVAL_SEC=0)');
      return;
    }
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();

    const limit = this.collector.heapLimit();
    this.logger.log(
      `Process vitals every ${intervalSec}s — heap limit ${mb(limit)} MB; ` +
        `warn at ${this.policy.warnPercent}%, snapshot at ${this.policy.snapshotPercent}% ` +
        `(${this.snapshotDir}), exit after ${this.policy.exitConsecutive} ticks over ${this.policy.exitPercent}%`,
    );

    this.timer = setInterval(() => this.tick(), intervalSec * 1000);
    // Never keep the process alive on our account.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.loopDelay?.disable();
  }

  /** One tick. Never throws: a diagnostics failure must not become an outage. */
  tick(): void {
    try {
      this.tickInner();
    } catch (err) {
      this.logger.warn(`vitals tick failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private tickInner(): void {
    const mem = this.collector.memory();
    const sample: HeapSample = { heapUsed: mem.heapUsed, heapLimit: this.collector.heapLimit() };
    const { actions, state, percent } = evaluateHeap(sample, this.policy, this.state);
    this.state = state;

    const resources = this.collector.activeResources();
    const byType: Record<string, number> = {};
    for (const r of resources) byType[r] = (byType[r] ?? 0) + 1;

    const loop = this.loopDelay
      ? { meanMs: Math.round(this.loopDelay.mean / 1e6), maxMs: Math.round(this.loopDelay.max / 1e6) }
      : undefined;
    this.loopDelay?.reset();

    const vitals = {
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      heapTotalMb: mb(mem.heapTotal),
      heapLimitMb: mb(sample.heapLimit),
      heapPercent: Math.round(percent * 10) / 10,
      externalMb: mb(mem.external),
      arrayBuffersMb: mb(mem.arrayBuffers),
      activeResources: resources.length,
      activeByType: byType,
      eventLoop: loop,
      gauges: processGauges.snapshot(),
    };
    // An object message: nestjs-pino merges it into the JSON line, so every
    // field is a column, not text inside `msg`.
    this.logger.log({ vitals, msg: 'vitals' });

    for (const action of actions) {
      if (action === 'warn') {
        this.logger.warn(
          `Heap at ${vitals.heapPercent}% of its ${vitals.heapLimitMb} MB limit ` +
            `(${vitals.heapUsedMb} MB used, rss ${vitals.rssMb} MB)`,
        );
      } else if (action === 'snapshot') {
        this.logger.warn(
          `Heap crossed ${this.policy.snapshotPercent}% — writing a heap snapshot to ${this.snapshotDir}. ` +
            `This blocks the event loop while it runs.`,
        );
        try {
          const out = this.effects.writeSnapshot(this.snapshotDir);
          this.logger.warn(
            `Heap snapshot written: ${out.path} (${mb(out.bytes)} MB in ${out.ms} ms). ` +
              `Open it in Chrome DevTools → Memory to see what is retained.`,
          );
        } catch (err) {
          this.logger.error(`Heap snapshot failed: ${(err as Error)?.message ?? err}`);
        }
      } else if (action === 'exit' && !this.exitRequested) {
        this.exitRequested = true;
        this.logger.error(
          `Heap has been over ${this.policy.exitPercent}% for ${this.policy.exitConsecutive} consecutive ticks ` +
            `(${vitals.heapUsedMb} of ${vitals.heapLimitMb} MB). Exiting gracefully before the ` +
            `GC death spiral makes the process unresponsive; the supervisor restarts it.`,
        );
        this.effects.requestExit();
      }
    }
  }
}
