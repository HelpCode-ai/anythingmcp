import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { setDbAllowedHostsProvider } from './ssrf.util';

const KEY = 'ssrf_allowed_hosts';
const CACHE_TTL_MS = 60_000;

/**
 * Source-of-truth for the SSRF allowlist. Merges the static env-var list
 * (SSRF_ALLOWED_HOSTS, for CI / bootstrap) with a DB-backed list the admin
 * can edit from the UI without restarting the backend.
 *
 * Cached in-process for 60s so we don't hit Postgres on every outbound HTTP
 * call. invalidate() lets the settings controller flush after a write so the
 * change applies on the next request.
 */
@Injectable()
export class SsrfPolicyService implements OnModuleInit {
  private readonly logger = new Logger(SsrfPolicyService.name);
  private cache: { value: string[]; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Wire the guard so every outbound URL check consults the DB list too.
    setDbAllowedHostsProvider(() => this.getEffectiveAllowedHosts());
  }

  /**
   * Effective allowlist = unique union of env hosts + DB hosts. Empty list is
   * a valid state — means "no extra hosts beyond public DNS".
   */
  async getEffectiveAllowedHosts(): Promise<string[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const envHosts = (process.env.SSRF_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    let dbHosts: string[] = [];
    try {
      const row = await this.prisma.siteSettings.findUnique({ where: { key: KEY } });
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) {
          dbHosts = parsed
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        }
      }
    } catch (err: any) {
      // Don't tank outbound calls if DB is briefly unreachable — env-only is
      // a safe fallback.
      this.logger.warn(
        `SsrfPolicyService: DB lookup failed, falling back to env: ${err.message}`,
      );
    }

    const merged = Array.from(new Set([...envHosts, ...dbHosts]));
    this.cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
    return merged;
  }

  /** Read just the DB layer (UI shows the admin-editable list, not env). */
  async getDbAllowedHosts(): Promise<string[]> {
    const row = await this.prisma.siteSettings.findUnique({ where: { key: KEY } });
    if (!row?.value) return [];
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /** Replace the DB-backed list. Validates basic hostname shape. */
  async setDbAllowedHosts(hosts: string[]): Promise<string[]> {
    const cleaned: string[] = [];
    for (const raw of hosts) {
      if (typeof raw !== 'string') continue;
      const h = raw.trim().toLowerCase();
      if (!h) continue;
      // Accept: hostnames, *.suffix wildcards, plain IPs. Reject anything
      // that looks like a URL or contains whitespace/control chars.
      if (!/^(?:\*\.)?[a-z0-9._:-]+$/i.test(h)) {
        throw new Error(`Invalid host entry: '${raw}'`);
      }
      cleaned.push(h);
    }
    const unique = Array.from(new Set(cleaned));
    await this.prisma.siteSettings.upsert({
      where: { key: KEY },
      update: { value: JSON.stringify(unique) },
      create: { key: KEY, value: JSON.stringify(unique) },
    });
    this.invalidate();
    return unique;
  }

  /** Force the next call to re-read DB. Used by the admin API after writes. */
  invalidate(): void {
    this.cache = null;
  }
}
