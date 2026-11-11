import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../common/redis.service';

/**
 * Short-lived memory of "the MCP endpoint just refused this OAuth client of
 * this user, for this server, because the user is not a member of the
 * server's workspace".
 *
 * WHY. Access and refresh tokens are bound to the instance-wide `/mcp`
 * resource, not to a server, so the refresh grant cannot tell from the token
 * which server a client wants. A client that sends the RFC 8707 `resource`
 * with its refresh names it; one that does not leaves only this trail. The
 * refresh arrives 0.3 to 1 s after the endpoint's 401, from the same client,
 * so a 15-minute marker keyed by (user, client) is enough to refuse it with
 * `invalid_grant`, which is what makes the client stop and authorize again
 * instead of looping 401 -> refresh -> 401 forever (#1609 follow-up).
 *
 * Redis when connected (shared by every backend process), else an in-memory
 * map with expiry and a size cap (correct for a single process). Every method
 * swallows errors: a lost marker means one more loop round, never a failed
 * request.
 */
@Injectable()
export class CrossWorkspaceRefusalStore {
  static readonly TTL_SECONDS = 15 * 60;
  static readonly MAX_MEMORY_ENTRIES = 10_000;

  private readonly logger = new Logger(CrossWorkspaceRefusalStore.name);
  /** Fallback while Redis is not connected. Insertion order = age. */
  private readonly memory = new Map<string, { serverId: string; expiresAt: number }>();

  constructor(@Optional() private readonly redis?: RedisService) {}

  private key(sub: string, clientId: string): string {
    return `xws:${sub}:${clientId}`;
  }

  /** Records that `serverId` refused this (user, client) as a non-member. */
  async mark(sub: string, clientId: string, serverId: string, now = Date.now()): Promise<void> {
    if (!sub || !clientId || !serverId) return;
    const key = this.key(sub, clientId);
    if (this.redis?.isConnected) {
      try {
        await this.redis.set(key, serverId, CrossWorkspaceRefusalStore.TTL_SECONDS);
        return;
      } catch (err: any) {
        this.logger.warn(`Could not store a refusal marker in Redis: ${err?.message ?? err}`);
      }
    }
    this.remember(key, serverId, now);
  }

  /** The server that refused this (user, client) in the last 15 minutes, or null. */
  async peek(sub: string, clientId: string, now = Date.now()): Promise<string | null> {
    if (!sub || !clientId) return null;
    const key = this.key(sub, clientId);
    if (this.redis?.isConnected) {
      try {
        const value = await this.redis.get(key);
        if (value) return value;
      } catch {
        // Fall back to memory: the marker may have been written there while
        // Redis was down.
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.memory.delete(key);
      return null;
    }
    return entry.serverId;
  }

  /** Forgets the marker (the user can reach the server again). */
  async clear(sub: string, clientId: string): Promise<void> {
    if (!sub || !clientId) return;
    const key = this.key(sub, clientId);
    this.memory.delete(key);
    if (this.redis?.isConnected) {
      try {
        await this.redis.del(key);
      } catch {
        // Expires on its own.
      }
    }
  }

  private remember(key: string, serverId: string, now: number): void {
    // Re-insert so the entry moves to the young end of the map.
    this.memory.delete(key);
    if (this.memory.size >= CrossWorkspaceRefusalStore.MAX_MEMORY_ENTRIES) {
      for (const [k, v] of this.memory) {
        if (v.expiresAt <= now) this.memory.delete(k);
      }
      // Still full: drop the oldest entries.
      while (this.memory.size >= CrossWorkspaceRefusalStore.MAX_MEMORY_ENTRIES) {
        const oldest = this.memory.keys().next().value;
        if (oldest === undefined) break;
        this.memory.delete(oldest);
      }
    }
    this.memory.set(key, {
      serverId,
      expiresAt: now + CrossWorkspaceRefusalStore.TTL_SECONDS * 1000,
    });
  }
}
