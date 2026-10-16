import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { OrgSettingsService } from '../settings/org-settings.service';
import { encrypt, decrypt } from '../common/crypto/encryption.util';
import { assertSafeOutboundUrl, SsrfBlockedError } from '../common/ssrf.util';
import { outboundRequest } from '../common/outbound-http';
import { getRequiredSecret } from '../common/secrets.util';
import {
  ALERT_WEBHOOK_SETTINGS_KEY,
  AlertWebhookConfig,
  AlertWebhookPublicConfig,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MINUTES,
} from './alerts.types';

export interface SaveAlertWebhookDto {
  url: string;
  type: 'json' | 'slack';
  enabled?: boolean;
  threshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  rotateSecret?: boolean;
}

export interface RecordFailureInput {
  organizationId: string;
  connectorId: string;
  toolId: string;
  error?: string;
}

export interface WebhookDispatchResult {
  success: boolean;
  status?: number;
  message?: string;
}

const MAX_ERROR_CHARS = 300;
/** HTTP request budget for a single webhook attempt. */
const DISPATCH_TIMEOUT_MS = 5000;
/** One retry on top of the first attempt — enough to ride out a blip without piling up requests. */
const DISPATCH_ATTEMPTS = 2;
/**
 * How long a webhook config (or its absence) is reused for failure counting.
 * recordFailure runs on every failed tool call of every organization, nearly
 * all of which have no webhook: without this, each failure cost a DB read.
 */
const CONFIG_CACHE_MS = 60_000;
const CONFIG_CACHE_MAX = 10_000;

/**
 * Detects a connector that keeps failing and dispatches a signed webhook
 * (or Slack message) so an admin finds out without having to watch the logs.
 *
 * Counting lives in Redis (shared across backend instances) with an
 * in-memory fallback for self-hosted installs that haven't configured it —
 * see `incrWithExpiry`/`isCooldownActive`/`setCooldown` below.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly encryptionKey: string;

  // In-memory fallback, used only while RedisService.isConnected is false.
  // Not shared across processes — fine for a single self-hosted instance,
  // and still correct (just not synchronized) across a horizontally scaled
  // Cloud deployment, where Redis is expected to be configured anyway.
  private readonly memCounters = new Map<string, { count: number; expiresAt: number }>();
  private readonly memCooldowns = new Map<string, number>();
  private readonly memFirstFailure = new Map<string, { value: string; expiresAt: number }>();
  private readonly configCache = new Map<string, { config: AlertWebhookConfig | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgSettings: OrgSettingsService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  // ── Admin-facing config ────────────────────────────────────────────────

  async getConfig(organizationId: string): Promise<AlertWebhookPublicConfig | { configured: false }> {
    const config = await this.orgSettings.getJson<AlertWebhookConfig>(
      organizationId,
      ALERT_WEBHOOK_SETTINGS_KEY,
    );
    if (!config?.url) return { configured: false };
    const { secretEnc: _secretEnc, ...publicConfig } = config;
    return publicConfig;
  }

  /**
   * Save the webhook config. Returns the plaintext secret once, only when a
   * new one was generated (first save, or `rotateSecret: true`) — the same
   * "shown once" pattern as an API key, since it is never stored in plain
   * text and `getConfig` never returns it again.
   */
  async saveConfig(
    organizationId: string,
    dto: SaveAlertWebhookDto,
  ): Promise<{ secret?: string }> {
    this.assertHttpsOnCloud(dto.url);
    try {
      // On Cloud the allowlists name hosts that only the platform may reach,
      // so a webhook URL supplied here must not inherit them (see
      // VetHostOptions in ssrf.util.ts). A self-hosted operator's allowlist is
      // their own, which is how an internal Mattermost or Slack proxy works.
      await assertSafeOutboundUrl(dto.url, process.env, { skipAllowlists: this.isCloud() });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const existing = await this.orgSettings.getJson<AlertWebhookConfig>(
      organizationId,
      ALERT_WEBHOOK_SETTINGS_KEY,
    );

    let secretEnc = existing?.secretEnc;
    let plaintextSecret: string | undefined;
    if (!secretEnc || dto.rotateSecret) {
      plaintextSecret = randomBytes(32).toString('hex');
      secretEnc = encrypt(plaintextSecret, this.encryptionKey, organizationId);
    }

    const config: AlertWebhookConfig = {
      url: dto.url,
      type: dto.type,
      enabled: dto.enabled ?? true,
      threshold: dto.threshold || DEFAULT_THRESHOLD,
      windowMinutes: dto.windowMinutes || DEFAULT_WINDOW_MINUTES,
      cooldownMinutes: dto.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES,
      secretEnc,
    };
    await this.orgSettings.setJson(organizationId, ALERT_WEBHOOK_SETTINGS_KEY, config);
    this.configCache.delete(organizationId);

    return plaintextSecret ? { secret: plaintextSecret } : {};
  }

  async deleteConfig(organizationId: string): Promise<void> {
    await this.orgSettings.delete(organizationId, ALERT_WEBHOOK_SETTINGS_KEY);
    this.configCache.delete(organizationId);
  }

  async testWebhook(organizationId: string): Promise<WebhookDispatchResult> {
    const config = await this.orgSettings.getJson<AlertWebhookConfig>(
      organizationId,
      ALERT_WEBHOOK_SETTINGS_KEY,
    );
    if (!config?.url) {
      throw new BadRequestException('No alert webhook is configured for this organization');
    }
    const now = new Date().toISOString();
    return this.dispatch(organizationId, config, {
      event: 'connector.test',
      organizationId,
      connector: { id: 'test', name: 'Test connector' },
      failures: 1,
      windowMinutes: config.windowMinutes,
      lastError: { tool: 'test_tool', message: 'This is a test alert from AnythingMCP.' },
      firstFailureAt: now,
      lastFailureAt: now,
      logsUrl: this.buildLogsUrl(),
    });
  }

  // ── Failure detection (called from AuditService.logInvocation) ─────────

  /**
   * Fire-and-forget: called for every non-SUCCESS invocation. Never throws —
   * any failure here must not affect the MCP tool-call path that triggered
   * it, so every exit point beyond the initial argument check is wrapped.
   */
  async recordFailure(input: RecordFailureInput): Promise<void> {
    try {
      const config = await this.cachedConfig(input.organizationId);
      if (!config?.enabled || !config.url) return;

      const threshold = config.threshold || DEFAULT_THRESHOLD;
      const windowSeconds = (config.windowMinutes || DEFAULT_WINDOW_MINUTES) * 60;
      const cooldownSeconds = (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60;
      const scope = `${input.organizationId}:${input.connectorId}`;
      const failKey = `alerts:fail:${scope}`;
      const cooldownKey = `alerts:cooldown:${scope}`;
      const firstFailureKey = `alerts:firstfail:${scope}`;

      const now = new Date();
      const count = await this.incrWithExpiry(failKey, windowSeconds, threshold);
      if (count === 1) {
        await this.setKeyWithExpiry(firstFailureKey, now.toISOString(), windowSeconds);
      }

      // Only the call that crosses the line dispatches. A later failure in
      // the same window pushes the count past `threshold` without ever
      // landing on it again, so it is naturally skipped until the window's
      // TTL lapses and a fresh cycle starts.
      if (count !== threshold) return;
      if (await this.isCooldownActive(cooldownKey)) return;
      // INCR is atomic, so only one call sees exactly `threshold`. The
      // cooldown is set before sending so a slow dispatch cannot overlap the
      // next window's alert.
      await this.setCooldown(cooldownKey, cooldownSeconds);

      const [connector, tool] = await Promise.all([
        this.prisma.connector.findFirst({
          where: { id: input.connectorId, organizationId: input.organizationId },
          select: { id: true, name: true },
        }),
        this.prisma.mcpTool.findUnique({
          where: { id: input.toolId },
          select: { name: true },
        }),
      ]);
      if (!connector) return;

      const firstFailureAt = (await this.getKey(firstFailureKey)) ?? now.toISOString();

      const result = await this.dispatch(input.organizationId, config, {
        event: 'connector.failing',
        organizationId: input.organizationId,
        connector: { id: connector.id, name: connector.name },
        failures: count,
        windowMinutes: config.windowMinutes || DEFAULT_WINDOW_MINUTES,
        lastError: {
          tool: tool?.name ?? input.toolId,
          message: truncate(input.error, MAX_ERROR_CHARS),
        },
        firstFailureAt,
        lastFailureAt: now.toISOString(),
        logsUrl: this.buildLogsUrl(connector.id),
      });
      if (!result.success) {
        // Never log the URL: a Slack webhook URL is itself a credential.
        this.logger.warn(
          `Connector-failure alert for org ${input.organizationId} was not delivered: ${result.status ?? ''} ${result.message ?? ''}`.trim(),
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to process connector-failure alert: ${err?.message || err}`);
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  private async dispatch(
    organizationId: string,
    config: AlertWebhookConfig,
    payload: Record<string, unknown>,
  ): Promise<WebhookDispatchResult> {
    let secret: string;
    try {
      secret = decrypt(config.secretEnc, this.encryptionKey, organizationId);
    } catch (err: any) {
      this.logger.warn(`Could not decrypt alert webhook secret for org ${organizationId}: ${err.message}`);
      return { success: false, message: 'Stored webhook secret could not be decrypted' };
    }

    const body =
      config.type === 'slack'
        ? JSON.stringify({ text: slackText(payload) })
        : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'X-AnythingMCP-Event': String(payload.event),
      'X-AnythingMCP-Timestamp': timestamp,
      'X-AnythingMCP-Signature': `sha256=${signature}`,
    };

    try {
      this.assertHttpsOnCloud(config.url);
    } catch (err: any) {
      return { success: false, message: err.message };
    }
    const skipAllowlists = this.isCloud();
    for (let attempt = 1; attempt <= DISPATCH_ATTEMPTS; attempt++) {
      try {
        // The outbound adapter re-checks every hop at send time (policy or
        // DNS can change after the save), with the same allowlist rule as
        // saveConfig.
        const res = await outboundRequest(
          {
            url: config.url,
            method: 'POST',
            data: body,
            headers,
            timeout: DISPATCH_TIMEOUT_MS,
            validateStatus: () => true,
          },
          { skipAllowlists, maxRedirects: 0 },
        );
        if (res.status >= 200 && res.status < 300) {
          return { success: true, status: res.status };
        }
        if (attempt === DISPATCH_ATTEMPTS || res.status < 500) {
          return { success: false, status: res.status, message: `Webhook responded with ${res.status}` };
        }
      } catch (err: any) {
        if (err instanceof SsrfBlockedError || attempt === DISPATCH_ATTEMPTS) {
          return { success: false, message: err.message };
        }
      }
    }
    return { success: false, message: 'Webhook dispatch failed' };
  }

  private isCloud(): boolean {
    return this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';
  }

  /** Signed alerts carry error text: on Cloud they only go out over TLS. */
  private assertHttpsOnCloud(url: string): void {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new BadRequestException('The webhook URL is not a valid URL');
    }
    if (this.isCloud() && protocol !== 'https:') {
      throw new BadRequestException('On AnythingMCP Cloud the webhook URL must use https');
    }
  }

  private async cachedConfig(organizationId: string): Promise<AlertWebhookConfig | null> {
    const now = Date.now();
    const hit = this.configCache.get(organizationId);
    if (hit && hit.expiresAt > now) return hit.config;
    const config =
      (await this.orgSettings.getJson<AlertWebhookConfig>(organizationId, ALERT_WEBHOOK_SETTINGS_KEY)) ?? null;
    if (this.configCache.size >= CONFIG_CACHE_MAX) this.configCache.clear();
    this.configCache.set(organizationId, { config, expiresAt: now + CONFIG_CACHE_MS });
    return config;
  }

  private buildLogsUrl(connectorId?: string): string {
    const base =
      (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return connectorId ? `${base}/logs?connectorId=${connectorId}` : `${base}/logs`;
  }

  // ── Counters: Redis when connected, in-memory fallback otherwise ───────

  private async incrWithExpiry(key: string, ttlSeconds: number, threshold: number): Promise<number> {
    if (this.redis.isConnected) {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, ttlSeconds);
      } else if (count > threshold && count % 20 === 0 && (await this.redis.ttl(key)) === -1) {
        // INCR and EXPIRE are two round trips: if the EXPIRE was lost, the
        // key would count past the threshold forever and never alert again.
        await this.redis.expire(key, ttlSeconds);
      }
      return count;
    }
    if (this.memCounters.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.memCounters) if (v.expiresAt <= now) this.memCounters.delete(k);
    }
    const now = Date.now();
    const entry = this.memCounters.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.memCounters.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  private async setKeyWithExpiry(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis.isConnected) {
      await this.redis.set(key, value, ttlSeconds);
      return;
    }
    this.memFirstFailure.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  private async getKey(key: string): Promise<string | null> {
    if (this.redis.isConnected) return this.redis.get(key);
    const entry = this.memFirstFailure.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  private async isCooldownActive(key: string): Promise<boolean> {
    if (this.redis.isConnected) return (await this.redis.get(key)) !== null;
    const expiresAt = this.memCooldowns.get(key);
    return !!expiresAt && expiresAt > Date.now();
  }

  private async setCooldown(key: string, ttlSeconds: number): Promise<void> {
    if (this.redis.isConnected) {
      await this.redis.set(key, '1', ttlSeconds);
      return;
    }
    this.memCooldowns.set(key, Date.now() + ttlSeconds * 1000);
  }
}

function truncate(text: string | undefined, maxChars: number): string {
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function slackText(payload: Record<string, unknown>): string {
  if (payload.event === 'connector.test') {
    return ':white_check_mark: AnythingMCP test alert: your webhook is configured correctly.';
  }
  const connector = payload.connector as { name?: string } | undefined;
  const lastError = payload.lastError as { tool?: string; message?: string } | undefined;
  // The connector name and the vendor's error text are not ours: escaped, so
  // an upstream body cannot ping <!channel> or disguise a link in the org's Slack.
  return (
    `:rotating_light: *${slackEscape(connector?.name ?? 'A connector')}* has failed ${payload.failures} times ` +
    `in the last ${payload.windowMinutes} minutes.\n` +
    `Last error (${slackEscape(lastError?.tool ?? 'unknown tool')}): ${slackEscape(lastError?.message ?? 'n/a')}\n` +
    `<${payload.logsUrl}|View logs>`
  );
}

function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
