import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { decrypt } from '../common/crypto/encryption.util';
import { computeSetupState } from '../connectors/connector-setup-status.util';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { EmailService } from '../settings/email.service';
import { AppApprovalTrialExtensionService } from '../license/app-approval-trial-extension.service';
import { AdaptersService } from './adapters.service';
import { getAdapter } from './catalog';
import {
  APP_APPROVAL_ADAPTERS,
  AppApprovalWatch,
  FIRST_PROMPT,
  SWEEP_LOOKBACK_MS,
  WATCH_FOR_MS,
  claudePromptUrl,
  isCheckDue,
  isReminderDue,
  pendingEvidence,
  readWatch,
  signInPath,
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
 * Two days later, a connector that still waits for the sign-in gets one
 * reminder, claimed the same way with `remindedAt` and the
 * `etsy_app_approved_reminded` event, and then nothing more. The reminder
 * needs no call to the provider: it reads the connector's own state.
 *
 * Cloud and self-hosted alike; without SMTP nothing is sent and the outcome
 * is only logged (the event says `not_sent`). On the Cloud the approval email
 * also extends a free trial that has run out meanwhile
 * (AppApprovalTrialExtensionService); self-hosted has no such trial.
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
    @Optional() private readonly trialExtension?: AppApprovalTrialExtensionService,
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

  /**
   * One pass: check every connector that is due, and remind the owners whose
   * reminder is due. Returns what it did, for the tests and the log.
   */
  async sweep(now: Date = new Date()): Promise<{ checked: number; notified: number; reminded: number }> {
    if (this.running) return { checked: 0, notified: 0, reminded: 0 };
    this.running = true;
    try {
      return await this.sweepOnce(now);
    } finally {
      this.running = false;
    }
  }

  private async sweepOnce(now: Date): Promise<{ checked: number; notified: number; reminded: number }> {
    const rows: Candidate[] = await this.prisma.connector.findMany({
      where: {
        // Keys are checked for WATCH_FOR_MS (isCheckDue); the read reaches
        // two days and a day further for the reminder of a late approval.
        createdAt: { gte: new Date(now.getTime() - SWEEP_LOOKBACK_MS) },
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
    const toRemind = rows.filter((r) => isReminderDue(readWatch(r.config), now));
    if (due.length === 0 && toRemind.length === 0) return { checked: 0, notified: 0, reminded: 0 };

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
    let reminded = 0;
    for (const row of toRemind) {
      const outcome = await this.remindOne(row, now).catch((err) => {
        this.logger.warn(`App approval reminder for connector ${row.id} failed: ${err?.message ?? err}`);
        return 'error' as const;
      });
      if (outcome === 'reminded') reminded++;
    }
    if (checked > 0 || reminded > 0) {
      this.logger.log(`App approval sweep: ${checked} checked, ${notified} notified, ${reminded} reminded`);
    }
    return { checked, notified, reminded };
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
    const claimed = await this.writeWatch(row.id, { ...patch, notifiedAt: now.toISOString() }, { claim: 'notifiedAt' });
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
      select: { email: true, name: true, emailMarketingOptOut: true },
    });
    const providerName = getAdapter(slug)?.name ?? slug;
    const prompt = FIRST_PROMPT[slug] ?? `Show what you can do with ${providerName}`;
    let sent = false;
    let trialDaysAdded = 0;
    if (owner?.email && this.email) {
      // An approval that comes when the free trial has run out leaves no time
      // to try the connector: ask for the existing extension first, so the
      // email can say so. Any refusal or failure sends the email without it.
      trialDaysAdded =
        (await this.trialExtension
          ?.extendIfTooLate(row.organizationId, { connectorId: row.id, adapterSlug: slug }, now)
          .catch((err) => {
            this.logger.warn(`Connector ${row.id}: trial extension not asked (${err?.message ?? err})`);
            return null;
          }))?.daysAdded ?? 0;
      sent = await this.email.sendAppApprovedEmail(
        owner.email,
        {
          name: owner.name ?? null,
          providerName,
          connectorPath: signInPath(row.id),
          prompt,
          promptUrl: claudePromptUrl(prompt),
          ...(trialDaysAdded > 0 ? { trialDaysAdded } : {}),
          // The reminder is not sent to an owner who opted out (remindOne).
          reminderFollows: !owner.emailMarketingOptOut,
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
      metadata: {
        connectorId: row.id,
        adapterSlug: slug,
        kind: sent ? 'emailed' : 'not_sent',
        ...(trialDaysAdded > 0 ? { trialDaysAdded } : {}),
      },
    });
    return true;
  }

  /**
   * The one reminder, 48 hours after the approval email (isReminderDue), for
   * a connector that still waits for the sign-in. Claimed with a conditional
   * write of remindedAt and checked against the `etsy_app_approved_reminded`
   * event, like the first email, so it goes out at most once.
   *
   * It is a nudge, not something the user is waiting for, so it follows the
   * rule of the other reminders (activation, onboarding, card-trial offer):
   * an owner who opted out of tips and offers gets none, and the email
   * carries the unsubscribe line. The claim is written all the same, with the
   * outcome `opted_out`, so the connector is not looked at again.
   */
  async remindOne(row: Candidate, now: Date): Promise<'skipped' | 'done' | 'reminded' | 'withheld'> {
    const slug = String((row.config as { adapterSlug?: unknown })?.adapterSlug ?? '');
    if (row.credentialScope === 'USER') return 'skipped';
    const state = computeSetupState({
      authType: row.authType,
      authConfig: this.openAuthConfig(row.authConfig),
      baseUrl: row.baseUrl,
      envVars: row.envVars,
      config: row.config,
    });
    if (state.status === 'ready') {
      // Signed in since the email: nothing to remind of.
      await this.writeWatch(row.id, { doneAt: now.toISOString() });
      return 'done';
    }
    // The keys were removed since: the sign-in is not what is missing.
    if (state.status !== 'needs_authorization') return 'skipped';

    const claimed = await this.writeWatch(row.id, { remindedAt: now.toISOString() }, { claim: 'remindedAt' });
    if (claimed !== 1) return 'skipped';
    const earlier = await this.prisma.productEvent.findFirst({
      where: {
        event: ProductEvents.ETSY_APP_APPROVED_REMINDED,
        organizationId: row.organizationId,
        metadata: { path: ['connectorId'], equals: row.id },
      },
      select: { id: true },
    });
    if (earlier) return 'skipped';

    const owner = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { email: true, name: true, emailMarketingOptOut: true },
    });
    const providerName = getAdapter(slug)?.name ?? slug;
    const prompt = FIRST_PROMPT[slug] ?? `Show what you can do with ${providerName}`;
    let kind: 'emailed' | 'not_sent' | 'opted_out' = 'not_sent';
    if (owner?.emailMarketingOptOut) {
      kind = 'opted_out';
    } else if (owner?.email && this.email) {
      const sent = await this.email.sendAppApprovedReminderEmail(
        owner.email,
        {
          name: owner.name ?? null,
          providerName,
          connectorPath: signInPath(row.id),
          prompt,
          promptUrl: claudePromptUrl(prompt),
        },
        row.organizationId,
      );
      if (sent) kind = 'emailed';
    }
    if (kind === 'not_sent') {
      this.logger.log(`Connector ${row.id}: ${providerName} sign-in still missing; no reminder sent (no SMTP or no owner address)`);
    }
    await this.productEvents.log({
      event: ProductEvents.ETSY_APP_APPROVED_REMINDED,
      userId: row.userId,
      organizationId: row.organizationId,
      metadata: { connectorId: row.id, adapterSlug: slug, kind },
    });
    return kind === 'opted_out' ? 'withheld' : 'reminded';
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
   * With `claim`, only while that email was not claimed yet (its date is
   * unset): returns 1 for the process that wins, 0 for any other.
   */
  private async writeWatch(
    id: string,
    patch: AppApprovalWatch,
    opts: { claim?: 'notifiedAt' | 'remindedAt' } = {},
  ): Promise<number> {
    const json = JSON.stringify(patch);
    if (opts.claim === 'notifiedAt') {
      return this.prisma.$executeRaw`
          UPDATE connectors
          SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
            || jsonb_build_object('appApprovalWatch', COALESCE(config->'appApprovalWatch', '{}'::jsonb) || ${json}::jsonb)
          WHERE id = ${id} AND (config->'appApprovalWatch'->>'notifiedAt') IS NULL`;
    }
    if (opts.claim === 'remindedAt') {
      return this.prisma.$executeRaw`
          UPDATE connectors
          SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
            || jsonb_build_object('appApprovalWatch', COALESCE(config->'appApprovalWatch', '{}'::jsonb) || ${json}::jsonb)
          WHERE id = ${id} AND (config->'appApprovalWatch'->>'remindedAt') IS NULL`;
    }
    return this.prisma.$executeRaw`
          UPDATE connectors
          SET config = (CASE WHEN jsonb_typeof(config) = 'object' THEN config ELSE '{}'::jsonb END)
            || jsonb_build_object('appApprovalWatch', COALESCE(config->'appApprovalWatch', '{}'::jsonb) || ${json}::jsonb)
          WHERE id = ${id}`;
  }
}
