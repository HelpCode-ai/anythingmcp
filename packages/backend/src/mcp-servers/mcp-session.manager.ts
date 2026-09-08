import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import type { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from '@modelcontextprotocol/node';

/**
 * A live, stateful MCP session held open between requests. Exists only when
 * the per-server MCP endpoint runs in stateful mode (MCP_STATEFUL_SESSIONS).
 *
 * Each session is bound to ONE (serverId, principal) pair so it can be reused
 * across the client's POST/GET/DELETE requests while staying tenant-isolated:
 * a session created by principal A on server X can never be driven by a
 * request authenticated as principal B or aimed at server Y.
 */
export interface McpSessionEntry {
  sessionId: string;
  serverId: string;
  organizationId: string | null;
  /** Stable identity of the owner (user sub / api-key name / static method). */
  principalKey: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  /** Live handles to this session's registered tools, keyed by tool name with
   * each tool's current signature, so rebuild() can diff and touch only what
   * changed. Owned/mutated by the controller. */
  handles: Map<string, { handle: { remove: () => void }; sig: string }>;
  /** Content signature of the current tool set; rebuild() compares against it
   * to skip work when nothing changed. Owned/mutated by the controller. */
  signature: string;
  /**
   * Recompute this session's tool set from the current registry and emit
   * notifications/tools/list_changed if it actually changed. Supplied by the
   * controller (which owns the registration logic). Must be idempotent and
   * never throw fatally.
   */
  rebuild: () => Promise<void>;
  lastActivity: number;
}

/**
 * Registry of live stateful MCP sessions, keyed by session id, with a
 * secondary index by server id. Responsible for lifecycle: reuse lookup,
 * idle eviction, a global cap, and pushing tool-list changes to connected
 * clients.
 */
@Injectable()
export class McpSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(McpSessionManager.name);
  private readonly sessions = new Map<string, McpSessionEntry>();
  private readonly byServer = new Map<string, Set<string>>();

  private readonly idleMs =
    (Number(process.env.MCP_SESSION_IDLE_MIN) || 30) * 60_000;
  private readonly maxSessions = Number(process.env.MCP_MAX_SESSIONS) || 500;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically evict idle sessions. unref() so the timer never keeps the
    // process alive (matters for tests / graceful shutdown).
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** Whether stateful session mode is enabled for the instance. */
  static isEnabled(): boolean {
    return process.env.MCP_STATEFUL_SESSIONS === 'true';
  }

  add(entry: McpSessionEntry): void {
    // Enforce the global cap by evicting the least-recently-active session.
    if (this.sessions.size >= this.maxSessions) {
      let oldest: McpSessionEntry | undefined;
      for (const s of this.sessions.values()) {
        if (!oldest || s.lastActivity < oldest.lastActivity) oldest = s;
      }
      if (oldest) {
        this.logger.warn(
          `MCP session cap (${this.maxSessions}) reached — evicting ${oldest.sessionId}`,
        );
        void this.remove(oldest.sessionId);
      }
    }

    this.sessions.set(entry.sessionId, entry);
    let set = this.byServer.get(entry.serverId);
    if (!set) {
      set = new Set();
      this.byServer.set(entry.serverId, set);
    }
    set.add(entry.sessionId);
    this.logger.debug(
      `Opened MCP session ${entry.sessionId} (server=${entry.serverId}, sessions=${this.sessions.size})`,
    );
  }

  get(sessionId: string): McpSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string, now: number): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivity = now;
  }

  /** Close and forget a session. Safe to call multiple times. */
  async remove(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    this.byServer.get(entry.serverId)?.delete(sessionId);
    if (this.byServer.get(entry.serverId)?.size === 0) {
      this.byServer.delete(entry.serverId);
    }
    try {
      await entry.transport.close();
      await entry.mcpServer.close();
    } catch {
      // Ignore cleanup errors — the session is gone regardless.
    }
    this.logger.debug(
      `Closed MCP session ${sessionId} (sessions=${this.sessions.size})`,
    );
  }

  /**
   * Tool surfaces changed somewhere (a connector reloaded, or a server's
   * connector assignment changed). Ask every live session to reconcile; each
   * session's rebuild() is a no-op unless ITS own tool set actually changed,
   * so a broad notify is cheap and avoids tracking connector→server maps here.
   */
  async notifyToolsChanged(): Promise<void> {
    if (this.sessions.size === 0) return;
    const entries = Array.from(this.sessions.values());
    await Promise.all(
      entries.map((e) =>
        e.rebuild().catch((err) =>
          this.logger.warn(
            `Failed to rebuild MCP session ${e.sessionId}: ${err?.message}`,
          ),
        ),
      ),
    );
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const entry of this.sessions.values()) {
      if (entry.lastActivity < cutoff) {
        this.logger.debug(`Evicting idle MCP session ${entry.sessionId}`);
        void this.remove(entry.sessionId);
      }
    }
  }

  // Wall-clock read isolated for testability and to keep call sites terse.
  private now(): number {
    return Date.now();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.remove(id)));
  }
}
