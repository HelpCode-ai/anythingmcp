import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { decrypt } from '../common/crypto/encryption.util';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { EmailService } from '../settings/email.service';
import { AdaptersService } from './adapters.service';
import { getAdapter } from './catalog';
import {
  APP_APPROVAL_ADAPTERS,
  AppApprovalWatch,
  FIRST_PROMPT,
  WATCH_FOR_MS,
  claudePromptUrl,
  isCheckDue,
  pendingEvidence,
  readWatch,
} from './app-approval-watch';

/** How often due connectors are looked for. Checks themselves follow app-approval-watch.ts. */
const SWEEP_MS = 15 * 60 * 1000;
/** First sweep after boot: late enough to stay out of the startup work. */
const SWEEP_FIRST_MS = 3 * 60 * 1000;
/** Connectors read per sweep; the oldest first, the rest wait for the next sweep. */
const SWEEP_BATCH = 500;

type Candidate = {
  id: string;
  userId: string;
  organizationId: string;
  createdAt: Date;
  baseUrl: string;
  authType: string;
  authConfig: string | null;
  envVars: unknown;
  config: unknown;
  credentialScope: string;
};

/**
 * Re-checks the app keys of catalog connectors whose provider has not
 * approved the user's app yet (Etsy: a new app stays Pending for days), and
 * emails the connector's owner once when the provider accepts them, with a
 * link to finish the sign-in. See app-approval-watch.ts for why, the schedule
 * (hourly the first day, then every 6 hours, for 14 days) and the state kept
 * in the connector's config.
 *
 * Several backend processes may run the sweep: a check twice is harmless (one
 * cheap GET), and the email is claimed with a conditional write of
 * `notifiedAt`, then checked against the `etsy_app_approved_notified` event,
 * so it goes out at most once per connector, across restarts too.
 *
 * Cloud and self-hosted alike; without SMTP nothing is sent and the outcome
 * is only logged (the event says `not_sent`).
 */
@Injectable()
export class AppApprovalWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppApprovalWatcherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly productEvents: ProductEventService,
    @Optional() private readonly email?: EmailService,
  ) {}

  onModuleInit(): void {
    const sweep = () => void this.sweep().catch((err) => this.logger.warn(`App approval sweep failed: ${err?.message ?? err}`));
    this.first = setTimeout(sweep, SWEEP_FIRST_MS);
    this.first.unref?.();
    this.timer = setInterval(sweep, SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: check every connector that is due. Returns what it did, for the tests and the log. */
  async sweep(now: Date = new Date()): Promise<{ checked: number; notified: number }> {
    if (this.running) return { checked: 0, notified: 0 };
    this.running = true;
    try {
      return await this.sweepOnce(now);
    } finally {
      this.running = false;
    }
  }

  private async sweepOnce(now: Date): Promise<{ checked: number; notified: number }> {
    const rows: Candidate[] = await this.prisma.connector.findMany({
      where: {
        createdAt: { gte: new Date(now.getTime() - WATCH_FOR_MS) },
        authType: 'OAUTH2',
        OR: [...APP_APPROVAL_ADAPTERS].map((slug) => ({ config: { path: ['adapterSlug'], equals: slug } })),
      },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        createdAt: true,
        baseUrl: true,
        authType: true,
        authConfig: true,
        envVars: true,
        config: true,
        credentialScope: true,
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH,
    });
    const due = rows.filter((r) => isCheckDue(readWatch(r.config), r.createdAt, now));
    if (due.length === 0) return { checked: 0, notified: 0 };

    // The setup check's refusals, for connectors this job has not seen refused yet.
    const needEvidence = due.filter((r) => !readWatch(r.config).pendingSince);
    const events = needEvidence.length
      ? await this.prisma.productEvent.findMany({
          where: {
            organizationId: { in: [...new Set(needEvidence.map((r) => r.organizationId))] },
            event: { in: [ProductEvents.ETSY_APP_PENDING_SEEN, ProductEvents.SETUP_VERIFY_FAILED] },
            createdAt: { gte: new Date(now.getTime() - WATCH_FOR_MS - 24 * 60 * 60 * 1000) },
          },
          select: { event: true, organizationId: true, createdAt: true, metadata: true },
        })
      : [];

    let checked = 0;
    let notified = 0;
    for (const row of due) {
      const outcome = await this.checkOne(row, events, now).catch((err) => {
        this.logger.warn(`App approval check of connector ${row.id} failed: ${err?.message ?? err}`);
        return 'error' as const;
      });
      if (outcome !== 'skipped') checked++;
      if (outcome === 'notified') notified++;
    }
    if (checked > 0) this.logger.log(`App approval sweep: ${checked} checked, ${notified} notified`);
    return { checked, notified };
  }

  /** Check one connector and move its watch on. */
  async checkOne(
    row: Candidate,
    events: Array<{ event: string; organizationId: string | null; createdAt: Date; metadata: unknown }>,
    now: Date,
  ): Promise<'skipped' | 'done' | 'pending' | 'unknown' | 'not_pending' | 'notified'> {
    const slug = String((row.config as { adapterSlug?: unknown })?.adapterSlug ?? '');
    const watch = readWatch(row.config);
    // Each user signs in on their own: the connector itself never waits for one.
    if (row.credentialScope === 'USER') return 'skipped';

    const state = computeSetupState({
      authType: row.authType,
      authConfig: this.openAuthConfig(row.authConfig),
      baseUrl: row.baseUrl,
      envVars: row.envVars,
      config: row.config,
    });
    if (state.status === 'ready') {
      // Signed in while we waited: nothing to tell.
      await this.writeWatch(row.id, { doneAt: now.toISOString() });
      return 'done';
    }
    // No keys stored (yet): nothing to check with.
    if (state.status !== 'needs_authorization') return 'skipped';

    const envVars = Object.fromEntries(
      Object.entries((row.envVars ?? {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, v as string]),
    );
    const evidence = watch.pendingSince
      ? undefined
      : pendingEvidence({ id: row.id, organizationId: row.organizationId, createdAt: row.createdAt, adapterSlug: slug }, events, ProductEvents.ETSY_APP_PENDING_SEEN);
    const pendingSince = watch.pendingSince ?? evidence?.toISOString();

    const answer = await this.adapters.recheckAppKeys(slug, row.baseUrl, envVars);
    const patch: AppApprovalWatch = { lastCheckedAt: now.toISOString() };

    if (answer === 'unknown') {
      if (pendingSince && !watch.pendingSince) patch.pendingSince = pendingSince;
      await this.writeWatch(row.id, patch);
      return 'unknown';
    }
    if (answer === 'refused') {
      patch.pendingSince = pendingSince ?? now.toISOString();
      await this.writeWatch(row.id, patch);
      if (!watch.pendingSince) {
        await this.productEvents.log({
          event: ProductEvents.ETSY_APP_PENDING_SEEN,
          userId: row.userId,
          organizationId: row.organizationId,
          metadata: { adapterSlug: slug, via: 'watcher', connectorId: row.id },
        });
      }
      return 'pending';
    }
    // Accepted.
    if (!pendingSince) {
      // Never seen refused: the keys always worked and the user has simply
      // not signed in. Not an approval to announce.
      await this.writeWatch(row.id, { ...patch, notPending: now.toISOString() });
      return 'not_pending';
    }
    return (await this.notifyOnce(row, slug, { ...patch, pendingSince, approvedAt: now.toISOString() }, now))
      ? 'notified'
      : 'done';
  }

  /**
   * Claim the email (conditional write of notifiedAt), make sure no earlier
   * process recorded one for this connector, then send it. True when this
   * process sent it or tried to.
   */
  private async notifyOnce(row: Candidate, slug: string, patch: AppApprovalWatch, now: Date): Promise<boolean> {
    const claimed = await this.writeWatch(row.id, { ...patch, notifiedAt: now.toISOString() }, { claim: true });
    if (claimed !== 1) return false;
    const earlier = await this.prisma.productEvent.findFirst({
      where: {
        event: ProductEvents.ETSY_APP_APPROVED_NOTIFIED,
        organizationId: row.organizationId,
        metadata: { path: ['connectorId'], equals: row.id },
      },
      select: { id: true },
    });
    if (earlier) return false;

    const owner = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { email: true, name: true },
    });
    const providerName = getAdapter(slug)?.name ?? slug;
    const prompt = FIRST_PROMPT[slug] ?? `Show what you can do with ${providerName}`;
    let sent = false;
    if (owner?.email && this.email) {
      sent = await this.email.sendAppApprovedEmail(
        owner.email,
        {
          name: owner.name ?? null,
          providerName,
          connectorPath: `/connectors/${encodeURIComponent(row.id)}`,
          prompt,
          promptUrl: claudePromptUrl(prompt),
        },
        row.organizationId,
      );
    }
    if (!sent) {
      this.logger.log(`Connector ${row.id}: ${providerName} accepted the app keys; no email sent (no SMTP or no owner address)`);
    }
    await this.productEvents.log({
      event: ProductEvents.ETSY_APP_APPROVED_NOTIFIED,
      userId: row.userId,
      organizationId: row.organizationId,
      metadata: { connectorId: row.id, adapterSlug: slug, kind: sent ? 'emailed' : 'not_sent' },
    });
    return true;
  }

  private openAuthConfig(value: string | null): unknown {
    if (!value) return undefined;
    try {
      return JSON.parse(decrypt(value, process.env.ENCRYPTION_KEY || ''));
    } catch {
      return undefined;
    }
  }

  /**
   * Merge `patch` into config.appApprovalWatch (WATCH_CONFIG_KEY) in one
   * statement, leaving every other config key and a concurrent edit alone.
   * With `claim`, only while no email was claimed: returns 1 for the process
   * that wins, 0 for any other.
   */
  private async writeWatch(id: string, patch: AppApprovalWatch, opts: { claim?: boolean } = {}): Promise<number> {
    const json = JSON.stringify(patch);
    return opts.claim
      ? this.prisma.$executeRaw`
          UPDATE connectors
          SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
            || jsonb_build_object('appApprovalWatch', COALESCE(config->'appApprovalWatch', '{}'::jsonb) || ${json}::jsonb)
          WHERE id = ${id} AND (config->'appApprovalWatch'->>'notifiedAt') IS NULL`
      : this.prisma.$executeRaw`
          UPDATE connectors
          SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
            || jsonb_build_object('appApprovalWatch', COALESCE(config->'appApprovalWatch', '{}'::jsonb) || ${json}::jsonb)
          WHERE id = ${id}`;
  }
}
