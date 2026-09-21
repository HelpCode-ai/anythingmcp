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
  readCgroupMemoryLimit,
  readHeapPolicy,
  readSnapshotDir,
  readVitalsIntervalSec,
} from './process-vitals';

/** What a tick reads. Overridable so tests can feed numbers. */
export interface VitalsCollector {
  memory(): NodeJS.MemoryUsage;
  heapLimit(): number;
  /** The cgroup memory limit, or undefined when unlimited. Read once. */
  rssLimit(): number | undefined;
  activeResources(): string[];
}

/** What a tick may do. Overridable so tests never write a snapshot or send a signal. */
export interface VitalsEffects {
  writeSnapshot(dir: string): { path: string; bytes: number; ms: number };
  requestExit(): void;
  /** Wait; lets the log line before a blocking operation reach stdout. */
  pause(ms: number): Promise<void>;
}

const defaultCollector: VitalsCollector = {
  memory: () => process.memoryUsage(),
  heapLimit: () => v8.getHeapStatistics().heap_size_limit,
  rssLimit: () => readCgroupMemoryLimit(),
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
  pause: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const MB = 1048576;
const mb = (n: number | undefined) => (n === undefined ? undefined : Math.round((n / MB) * 10) / 10);

/**
 * Logs one `vitals` line per interval and acts on memory pressure.
 *
 * Why this exists, and why it looks the way it does, is in process-vitals.ts.
 * What it does each tick:
 *
 *   1. read memory, the heap limit, the cgroup limit, event-loop delay,
 *      active handles and the live gauges other modules maintain;
 *   2. log them as one structured line, so the trend before any incident is
 *      in the log rather than reconstructed from `docker stats` afterwards;
 *   3. warn once when the heap crosses HEAP_WARN_PERCENT;
 *   4. if HEAP_SNAPSHOT_PERCENT is set and the process can show the room,
 *      write one heap snapshot per process — after a pause, so the line
 *      announcing it is on stdout before the event loop blocks;
 *   5. after HEAP_EXIT_CONSECUTIVE ticks with the heap over HEAP_EXIT_PERCENT
 *      of its limit, or RSS over HEAP_RSS_EXIT_PERCENT of the cgroup limit,
 *      exit gracefully. The alternatives are what happened on 20 and 21 Sep:
 *      minutes of stop-the-world GC serving nothing, then a hard abort — or a
 *      kernel SIGKILL with no log line at all.
 *
 * A separate process supervisor turns that exit into a restart.
 */
@Injectable()
export class ProcessVitalsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessVitalsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private loopDelay?: IntervalHistogram;
  private state: HeapState = { ...INITIAL_HEAP_STATE };
  private exitRequested = false;
  private rssLimit: number | undefined;
  private ticking = false;

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
    this.rssLimit = this.collector.rssLimit();

    const limit = this.collector.heapLimit();
    this.logger.log(
      `Process vitals every ${intervalSec}s — heap limit ${mb(limit)} MB, ` +
        `cgroup limit ${this.rssLimit ? `${mb(this.rssLimit)} MB` : 'none'}; ` +
        `warn at ${this.policy.warnPercent}%, snapshot at ${this.policy.snapshotPercent}% ` +
        `(${this.snapshotDir}), exit after ${this.policy.exitConsecutive} ticks over ` +
        `${this.policy.exitPercent}% heap or ${this.policy.rssExitPercent}% rss`,
    );

    this.timer = setInterval(() => void this.tick(), intervalSec * 1000);
    // Never keep the process alive on our account.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.loopDelay?.disable();
  }

  /** One tick. Never throws: a diagnostics failure must not become an outage. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a snapshot in progress; do not stack ticks
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.logger.warn(`vitals tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const mem = this.collector.memory();
    const sample: HeapSample = {
      heapUsed: mem.heapUsed,
      heapLimit: this.collector.heapLimit(),
      rss: mem.rss,
      rssLimit: this.rssLimit,
    };
    const { actions, state, percent, rssPct } = evaluateHeap(sample, this.policy, this.state);
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
      rssLimitMb: mb(this.rssLimit),
      rssPercent: rssPct === undefined ? undefined : Math.round(rssPct * 10) / 10,
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
      } else if (action === 'snapshot-skipped') {
        this.logger.warn(
          `Heap crossed ${this.policy.snapshotPercent}% but a snapshot would need about ` +
            `${vitals.heapUsedMb} MB more, and rss ${vitals.rssMb} MB of a ${vitals.rssLimitMb} MB ` +
            `cgroup limit leaves no room for it. Not writing one: that is how 21 Sep went.`,
        );
      } else if (action === 'snapshot') {
        this.logger.warn(
          `Heap crossed ${this.policy.snapshotPercent}% — writing a heap snapshot to ${this.snapshotDir}. ` +
            `This blocks the event loop while it runs and needs roughly ${vitals.heapUsedMb} MB more memory.`,
        );
        // Let that line reach stdout before the loop stops. It is the line
        // that explains the pause — and the kill, if one comes anyway.
        await this.effects.pause(300);
        try {
          const out = this.effects.writeSnapshot(this.snapshotDir);
          this.logger.warn(
            `Heap snapshot written: ${out.path} (${mb(out.bytes)} MB in ${out.ms} ms). ` +
              `Open it in Chrome DevTools → Memory to see what is retained.`,
          );
        } catch (err) {
          this.logger.error(`Heap snapshot failed: ${(err as Error)?.message ?? err}`);
        }
      } else if ((action === 'exit' || action === 'exit-rss') && !this.exitRequested) {
        this.exitRequested = true;
        const reason =
          action === 'exit'
            ? `heap over ${this.policy.exitPercent}% of its limit (${vitals.heapUsedMb} of ${vitals.heapLimitMb} MB)`
            : `rss over ${this.policy.rssExitPercent}% of the cgroup limit (${vitals.rssMb} of ${vitals.rssLimitMb} MB)`;
        this.logger.error(
          `Memory pressure for ${this.policy.exitConsecutive} consecutive ticks — ${reason}. ` +
            `Exiting gracefully before the GC death spiral or the kernel does it for us; the supervisor restarts the process.`,
        );
        await this.effects.pause(300);
        this.effects.requestExit();
      }
    }
  }
}
