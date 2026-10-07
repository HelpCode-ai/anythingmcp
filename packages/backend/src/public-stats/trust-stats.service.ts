import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { EMPTY_TRUST_STATS, TrustStats } from './trust-stats.format';

/** How long a set of numbers is served before it is refreshed. */
export const TRUST_STATS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const GITHUB_REPO_URL = 'https://api.github.com/repos/HelpCode-ai/anythingmcp';
const DOCKER_REPO_URL = 'https://hub.docker.com/v2/repositories/helpcodeai/anythingmcp/';

/**
 * Aggregate numbers shown on the sign-up page, the authorization page and in
 * emails: GitHub stars, Docker Hub pulls, the number of workspaces and of tool
 * calls in the last 30 days. Aggregates only, never anything about a person or
 * a workspace.
 *
 * Kept in memory for an hour. A stale set is served at once while a refresh
 * runs in the background, so no request (and no email) waits on GitHub after
 * the first one. A source that fails keeps its last known value. Workspaces
 * and tool calls come from this instance's own database: on a self-hosted
 * install they describe that install, not AnythingMCP Cloud.
 */
@Injectable()
export class TrustStatsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrustStatsService.name);
  private current: TrustStats = { ...EMPTY_TRUST_STATS };
  private fetchedAt = 0;
  private inFlight: Promise<TrustStats> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    // Warm the cache without holding up the boot.
    if (process.env.NODE_ENV !== 'test') void this.refresh();
  }

  /**
   * The current numbers. Waits only when nothing has been loaded yet; a stale
   * set is returned immediately and refreshed in the background.
   */
  async get(): Promise<TrustStats> {
    if (this.fetchedAt === 0) return this.refresh();
    if (Date.now() - this.fetchedAt > TRUST_STATS_TTL_MS) void this.refresh();
    return this.current;
  }

  /** What is in memory right now, without waiting; starts a refresh when due. */
  peek(): TrustStats {
    if (this.fetchedAt === 0 || Date.now() - this.fetchedAt > TRUST_STATS_TTL_MS) {
      void this.refresh();
    }
    return this.current;
  }

  private refresh(): Promise<TrustStats> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load()
      .then((next) => {
        this.current = next;
        this.fetchedAt = Date.now();
        return next;
      })
      .catch((err) => {
        // load() settles every source on its own; this is a last resort.
        this.logger.warn(`Trust stats not refreshed: ${err?.message ?? err}`);
        this.fetchedAt = Date.now();
        return this.current;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async load(): Promise<TrustStats> {
    const [stars, pulls, workspaces, calls] = await Promise.allSettled([
      this.fetchNumber(GITHUB_REPO_URL, 'stargazers_count', {
        Accept: 'application/vnd.github+json',
      }),
      this.fetchNumber(DOCKER_REPO_URL, 'pull_count'),
      this.prisma.organization.count(),
      this.prisma.toolInvocation.count({
        where: { createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      }),
    ]);
    const pick = (r: PromiseSettledResult<number | null>, last: number | null, what: string) => {
      if (r.status === 'fulfilled' && typeof r.value === 'number') return r.value;
      if (r.status === 'rejected') {
        this.logger.debug(`Trust stats: ${what} unavailable (${(r.reason as Error)?.message ?? r.reason})`);
      }
      return last;
    };
    const next: TrustStats = {
      githubStars: pick(stars, this.current.githubStars, 'GitHub stars'),
      dockerPulls: pick(pulls, this.current.dockerPulls, 'Docker pulls'),
      workspaces: pick(workspaces, this.current.workspaces, 'workspaces'),
      toolCalls30d: pick(calls, this.current.toolCalls30d, 'tool calls'),
      updatedAt: this.current.updatedAt,
    };
    const anyFresh = [stars, pulls, workspaces, calls].some(
      (r) => r.status === 'fulfilled' && typeof r.value === 'number',
    );
    if (anyFresh) next.updatedAt = new Date().toISOString();
    return next;
  }

  private async fetchNumber(
    url: string,
    field: string,
    headers: Record<string, string> = {},
  ): Promise<number | null> {
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'AnythingMCP', ...headers },
      // Only the one number is read; refuse anything large.
      maxContentLength: 512 * 1024,
    });
    const value = res.data?.[field];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
}
