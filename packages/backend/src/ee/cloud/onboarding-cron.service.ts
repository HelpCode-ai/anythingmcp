import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { getAdapter } from '../../adapters/catalog';
import { ProductEvents } from '../../audit/product-event.service';
import { EmailService } from '../../settings/email.service';
import type { RetentionOffer, WinbackOffer } from '../../settings/email-templates';
import { LicenseService } from '../../license/license.service';
import { LicenseReleaseService } from '../../license/license-release.service';
import { CardTrialOfferService } from '../../license/card-trial-offer.service';
import { RetentionLicenceClient } from '../../license/retention-licence.client';
import { cloudFrontendOrigin } from '../../license/license-checkout';
import { createTrialExtensionToken, trialExtensionSecret } from '../../license/trial-extension-token';
import {
  WINBACK_HOLDOUT_KEY,
  WINBACK_OFFER_KEY,
  type WinbackSegment,
  holdoutValue,
  inWinbackHoldout,
  isHoldoutValue,
  offerValue,
  winbackSegment,
} from './winback-segment';
import {
  INTENT_EVENTS,
  QUICK_SETUPS,
  type ReminderArm,
  attributedIntent,
  claudeChatUrl,
  reminderArm,
} from './onboarding-reminder';

const HOURS = (n: number) => n * 60 * 60 * 1000;

/**
 * How long after signing up a user with an empty workspace gets the first
 * nudge: how to connect an app, from the chat or the dashboard. It used to be
 * 24 hours (2 for someone who had connected an AI client), by when most of
 * those sign-ups had left. The cron runs hourly.
 */
const FIRST_NUDGE_AFTER = HOURS(1);
const DAYS = (n: number) => n * 24 * 60 * 60 * 1000;

/**
 * Win-back after a Cloud trial ends. Until 6 Oct 2026 the licence site sent
 * every Cloud trial the same 50% code a week and a month after expiry (about
 * 2,100 emails, one redemption): most of those people never connected an app.
 * The site has no usage data; this cron does, so Cloud trials are won back from
 * here and the site keeps the self-hosted ones.
 *
 * Someone who made a successful call gets their segment's offer
 * (winback-segment.ts, RETENTION_OFFERS) a day after expiry and again a month
 * after, each time with fresh single-use codes, since the licence site's
 * codes expire after 14 days; someone who never did gets one email on how to
 * connect an app from the chat, a day after. Only trials that ended from WINBACK_FROM on:
 * earlier ones were already sent the site's win-back.
 *
 * The first stage went out a week after expiry until 8 Oct 2026, before any
 * of it was sent. Its window now runs from 1 to 7 days: the hourly cron mails
 * new trials at about a day, and the tail catches the trials that ended before
 * the change shipped. It keeps its OrgSettings key `trial_email_winback7`, so
 * no workspace can get the first stage twice.
 *
 * No win-back goes to a workspace that has or had a subscription: workspaces
 * with any licence other than the free trial are skipped, and the licence site
 * confirms, for every admin's address, that it never had a Stripe
 * subscription (a card trial whose licence never reached this server
 * included).
 *
 * Self-hosted: none of this runs. CloudModule, which provides this service, is
 * only imported when DEPLOYMENT_MODE=cloud (app.module.ts); self-hosted trials
 * are won back by the licence site.
 */
const WINBACK_FROM = new Date('2026-10-06T00:00:00Z');
const WINBACK_STAGES = [
  {
    stage: 'first',
    flagKey: 'trial_email_winback7',
    after: DAYS(1),
    until: DAYS(7),
  },
  {
    stage: 'final',
    flagKey: 'trial_email_winback30',
    after: DAYS(30),
    until: DAYS(37),
  },
] as const;

/**
 * The offer of each segment, minted per workspace by the licence site
 * (RetentionLicenceClient.winbackCode). 12-month prices on Cloud Starter, then
 * the list price, which every email states:
 *
 * - business: the locked price, €12/month for 12 months or €120 for the first
 *   year (two codes, one per billing period);
 * - consumer and Telegram, and never-used workspaces whose AI kept calling
 *   after the trial: Personal, €6/month for 12 months.
 *
 * The STARTER599 first-month test (Oct 2026) is over: no new arms. The arms
 * already stored in OrgSettings `winback_test_arm` stay for the history;
 * nothing reads them.
 */
const RETENTION_OFFERS: Record<WinbackSegment, RetentionOffer['kind']> = {
  business: 'locked',
  consumer: 'personal',
  telegram: 'personal',
  unused: 'personal',
};

/**
 * "Your AI tried to use X": an expired trial whose AI keeps calling its tools
 * (the `trial_expired_call_blocked` events the MCP tool path records, at most
 * one per workspace and tool an hour) is the warmest lead there is. Sent once
 * per workspace, to a workspace with at least `minEvents` of those in the last
 * `window`, with its segment's offer (RETENTION_OFFERS). It counts as the first win-back:
 * it also sets that stage's flag, so nobody gets two offers in a week. No two
 * win-back emails go out within `spacing` of each other, this one included.
 */
const BLOCKED_CALLS = {
  flagKey: 'trial_email_blocked_calls',
  window: HOURS(48),
  minEvents: 2,
  spacing: HOURS(24),
  /** Stored in `winback_offer` as the stage. */
  stage: 'blocked_calls',
} as const;

/** OrgSettings flags of the win-back emails, for the spacing between them. */
const WINBACK_EMAIL_FLAGS = [...WINBACK_STAGES.map((s) => s.flagKey), BLOCKED_CALLS.flagKey];

/**
 * Onboarding drip — finds users who registered, verified their email,
 * but never created a connector, and nudges them via email at two
 * milestones:
 *
 *   reminder 1 (FIRST_NUDGE_AFTER, an hour after signup): an A/B test with a
 *     10% control group that gets nothing (onboarding-reminder.ts);
 *   reminder 2 (≥72h after signup, ≥48h after the first): only to users who
 *     showed intent (a catalog search, a guided setup opened, or a sign-up
 *     through a channel other than 'direct'). Until Nov 2026 every user got
 *     it; 1.6% of them ever had a connector.
 *
 * Cap is 2 emails. After that we leave them alone — we'd rather lose
 * an inactive trial than annoy someone enough to mark us as spam.
 *
 * State columns on users (migration 20260528100000):
 *   onboarding_completed_at      — null = wizard not yet finished
 *   onboarding_last_reminder_at  — last drip email sent (null for a holdout
 *                                  user who got none)
 *   onboarding_reminder_count    — the drip step reached, terminal at 2: a
 *                                  holdout user is at 1 without an email
 *                                  (product events tell sent from withheld)
 *   email_marketing_opt_out      — hard unsubscribe
 *
 * Idempotency: the cron is fine to re-run within a window — counters
 * + timing checks prevent duplicate sends. Worst case a missed run
 * sends a reminder a few hours late.
 */
/**
 * One run at a time, across processes. The cron is called by a timer on the
 * Cloud host every hour and by the GitHub workflow as a fallback, and during a
 * blue/green deploy two backends are up. Nothing in a run is atomic per email
 * (send, then set the flag), so two runs at once could mail someone twice. A
 * lease row in site_settings (value = holder, '' = free) is taken with one
 * conditional update; a lease older than LEASE_MS counts as free, so a crashed
 * run never blocks the next ones for long.
 */
const LEASE_KEY = 'onboarding_cron_lease';
const LEASE_MS = 30 * 60 * 1000;

@Injectable()
export class OnboardingCronService {
  private readonly logger = new Logger(OnboardingCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly license: LicenseService,
    private readonly licenseRelease: LicenseReleaseService,
    @Optional() private readonly cardTrialOffer?: CardTrialOfferService,
    @Optional() private readonly codes?: RetentionLicenceClient,
  ) {}

  /** run() unless another run holds the lease; null when skipped. */
  async runExclusive(): Promise<Awaited<ReturnType<OnboardingCronService['run']>> | null> {
    const holder = randomUUID();
    if (!(await this.acquireLease(holder))) {
      this.logger.log('Onboarding cron already running elsewhere; this call was skipped.');
      return null;
    }
    try {
      return await this.run();
    } finally {
      await this.prisma.siteSettings
        .updateMany({ where: { key: LEASE_KEY, value: holder }, data: { value: '' } })
        .catch((err) => this.logger.warn(`Could not release the onboarding cron lease: ${err?.message ?? err}`));
    }
  }

  private async acquireLease(holder: string): Promise<boolean> {
    const taken = await this.prisma.siteSettings.updateMany({
      where: {
        key: LEASE_KEY,
        OR: [{ value: '' }, { updatedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
      },
      data: { value: holder },
    });
    if (taken.count === 1) return true;
    const exists = await this.prisma.siteSettings.findUnique({ where: { key: LEASE_KEY }, select: { id: true } });
    if (exists) return false;
    try {
      await this.prisma.siteSettings.create({ data: { key: LEASE_KEY, value: holder } });
      return true;
    } catch {
      // Another run created the row first (unique key): it holds the lease.
      return false;
    }
  }

  async run(): Promise<{
    examined: number;
    firstReminders: number;
    firstReminderHoldout: number;
    secondReminders: number;
    secondRemindersWithheld: number;
    activationReminders: number;
    trialWarn3: number;
    trialWarn1: number;
    trialExpired: number;
    trialEmailsWithheld: number;
    trialsMarkedExpired: number;
    trialsRepaired: number;
    licensesReverified: number;
    licensesDeactivated: number;
    licensesReleased: number;
    winbackOffers: number;
    winbackHelp: number;
    winbackHoldout: number;
    trialExpiredBusiness: number;
    blockedCallEmails: number;
    blockedCallHoldout: number;
    cardTrialOffers: number;
    skipped: number;
  }> {
    const now = Date.now();
    const out = {
      examined: 0,
      firstReminders: 0,
      firstReminderHoldout: 0,
      secondReminders: 0,
      secondRemindersWithheld: 0,
      activationReminders: 0,
      trialWarn3: 0,
      trialWarn1: 0,
      trialExpired: 0,
      trialEmailsWithheld: 0,
      trialsMarkedExpired: 0,
      trialsRepaired: 0,
      licensesReverified: 0,
      licensesDeactivated: 0,
      licensesReleased: 0,
      winbackOffers: 0,
      winbackHelp: 0,
      winbackHoldout: 0,
      trialExpiredBusiness: 0,
      blockedCallEmails: 0,
      blockedCallHoldout: 0,
      cardTrialOffers: 0,
      skipped: 0,
    };

    // Candidate set: verified, ≤2 reminders, not opted out, registered
    // between FIRST_NUDGE_AFTER and 14d ago. We bound at 14d so a user
    // who signed up months ago doesn't suddenly get woken up if we ever
    // backfill columns.
    //
    // onboardingCompletedAt is NOT a filter any more: the Skip button on
    // /welcome sets it, and people who skipped the page with an empty
    // workspace stopped getting the reminders that were meant for exactly
    // them (13 of the 428 sign-ups of 1-3 Oct 2026). What counts is whether
    // the workspace has a connector, checked below.
    const candidates = await this.prisma.user.findMany({
      where: {
        emailVerified: true,
        emailMarketingOptOut: false,
        onboardingReminderCount: { lt: 2 },
        createdAt: {
          lte: new Date(now - FIRST_NUDGE_AFTER),
          gte: new Date(now - HOURS(24 * 14)),
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        organizationId: true,
        onboardingCompletedAt: true,
        onboardingReminderCount: true,
        onboardingLastReminderAt: true,
        _count: { select: { connectors: true } },
      },
    });

    // Connectors per workspace: a teammate's connector serves this user too.
    const orgIds = [
      ...new Set(candidates.map((u) => u.organizationId).filter((id): id is string => !!id)),
    ];
    const orgConnectors = new Map<string, number>();
    if (orgIds.length > 0) {
      const rows = await this.prisma.connector.groupBy({
        by: ['organizationId'],
        where: { organizationId: { in: orgIds } },
        _count: { _all: true },
      });
      for (const r of rows) {
        if (r.organizationId) orgConnectors.set(r.organizationId, r._count._all);
      }
    }

    // Who already connected an AI client (Claude, ChatGPT…) and how long ago.
    // These are the warmest leads of all: the client is waiting on a
    // workspace with nothing in it.
    const aiClients = await this.connectedAiClients(
      candidates.map((u) => u.id),
      now,
    );

    // Who of those due for reminder 2 showed intent (onboarding-reminder.ts).
    const secondDue = (u: (typeof candidates)[number]) =>
      u.onboardingReminderCount === 1 &&
      now - u.createdAt.getTime() >= HOURS(72) &&
      (!u.onboardingLastReminderAt || now - u.onboardingLastReminderAt.getTime() >= HOURS(48));
    const withIntent = await this.usersWithIntent(candidates.filter(secondDue), now);

    for (const u of candidates) {
      out.examined++;

      // Race-safe: a workspace that got a connector between candidate pull
      // and now should never receive a nudge.
      const connectors =
        (u.organizationId ? orgConnectors.get(u.organizationId) : undefined) ??
        u._count.connectors;
      if (connectors > 0) {
        // Auto-stamp completion so we never see them again.
        if (!u.onboardingCompletedAt) {
          await this.prisma.user
            .update({
              where: { id: u.id },
              data: { onboardingCompletedAt: new Date() },
            })
            .catch(() => {});
        }
        out.skipped++;
        continue;
      }

      const age = now - u.createdAt.getTime();
      const sinceLast = u.onboardingLastReminderAt
        ? now - u.onboardingLastReminderAt.getTime()
        : Infinity;

      // First nudge: an hour after signup (every candidate is at least that
      // old). Someone who already connected an AI client is told to ask it
      // for the app in the same chat, naming the client, in both arms; arm B
      // replaces the generic how-to with one-click Claude chats; the holdout
      // gets nothing, and moves on to the reminder-2 step all the same.
      const aiClient = aiClients.get(u.id);
      const arm = reminderArm(u.id);
      if (u.onboardingReminderCount === 0) {
        if (arm === 'holdout') {
          await this.prisma.user.update({
            where: { id: u.id },
            data: { onboardingReminderCount: 1 },
          });
          await this.reminderEvent(ProductEvents.ONBOARDING_REMINDER_HOLDOUT, u, 1, arm);
          out.firstReminderHoldout++;
          continue;
        }
        const ok = await this.email.sendOnboardingReminderEmail(
          u.email,
          u.name || 'there',
          1,
          aiClient
            ? { aiClient }
            : arm === 'B'
              ? { quickSetups: QUICK_SETUPS.map((q) => ({ label: q.label, url: claudeChatUrl(q.request) })) }
              : undefined,
        );
        if (ok) {
          await this.prisma.user.update({
            where: { id: u.id },
            data: {
              onboardingReminderCount: 1,
              onboardingLastReminderAt: new Date(),
            },
          });
          await this.reminderEvent(ProductEvents.ONBOARDING_REMINDER_SENT, u, 1, arm, aiClient ? 'ai_client' : 'generic');
          out.firstReminders++;
        } else {
          out.skipped++;
        }
        continue;
      }

      // Second nudge: count == 1, ≥72h after signup AND ≥48h since first,
      // and only with intent. Without it the user stays at step 1 and is
      // asked about again on the next runs, until 14 days after sign-up.
      if (
        u.onboardingReminderCount === 1 &&
        age >= HOURS(72) &&
        sinceLast >= HOURS(48)
      ) {
        if (!withIntent.has(u.id)) {
          out.secondRemindersWithheld++;
          out.skipped++;
          continue;
        }
        const ok = await this.email.sendOnboardingReminderEmail(
          u.email,
          u.name || 'there',
          2,
        );
        if (ok) {
          await this.prisma.user.update({
            where: { id: u.id },
            data: {
              onboardingReminderCount: 2,
              onboardingLastReminderAt: new Date(),
            },
          });
          await this.reminderEvent(ProductEvents.ONBOARDING_REMINDER_SENT, u, 2, arm, 'generic');
          out.secondReminders++;
        } else {
          out.skipped++;
        }
        continue;
      }

      out.skipped++;
    }

    await this.runActivationPass(now, out);
    await this.runTrialLifecyclePass(now, out);
    await this.runWinbackPass(now, out);
    // After the win-back pass, so a first win-back it just sent holds this
    // one back for a day (BLOCKED_CALLS.spacing).
    await this.runBlockedCallPass(now, out);
    // After the lifecycle and win-back passes, so an email they just sent
    // holds this one back (12 hours; see card-trial-offer.service.ts).
    out.cardTrialOffers = (await this.cardTrialOffer?.runEmailPass(new Date(now)))?.sent ?? 0;
    out.trialsMarkedExpired = await this.markExpiredTrials(now);

    // Before nudging anyone about their trial, make sure they actually got one.
    // A verified user with no licence at all sees the licence wall instead of
    // onboarding, and every drip email we send them is about something they
    // cannot use.
    out.trialsRepaired = (await this.license.repairMissingTrials()).repaired;

    // Paid licences are re-checked against the licence server about once a
    // day, so a cancelled or unpaid subscription stops working here too.
    const reverified = await this.license.reverifyPaidLicenses();
    out.licensesReverified = reverified.checked;
    out.licensesDeactivated = reverified.deactivated;

    // Licences of deleted workspaces the licence site has not confirmed
    // ended yet: a release right after the deletion can fail.
    out.licensesReleased = (await this.licenseRelease.releaseOrphanedLicenses()).released;

    this.logger.log(
      `Onboarding drip: examined=${out.examined} first=${out.firstReminders} ` +
        `firstHoldout=${out.firstReminderHoldout} second=${out.secondReminders} ` +
        `secondWithheld=${out.secondRemindersWithheld} activation=${out.activationReminders} ` +
        `trialWarn3=${out.trialWarn3} trialWarn1=${out.trialWarn1} trialExpired=${out.trialExpired} ` +
        `trialEmailsWithheld=${out.trialEmailsWithheld} ` +
        `trialsMarkedExpired=${out.trialsMarkedExpired} trialsRepaired=${out.trialsRepaired} ` +
        `licensesReverified=${out.licensesReverified} licensesDeactivated=${out.licensesDeactivated} ` +
        `licensesReleased=${out.licensesReleased} winbackOffers=${out.winbackOffers} ` +
        `winbackHelp=${out.winbackHelp} trialExpiredBusiness=${out.trialExpiredBusiness} ` +
        `winbackHoldout=${out.winbackHoldout} blockedCallEmails=${out.blockedCallEmails} ` +
        `blockedCallHoldout=${out.blockedCallHoldout} ` +
        `cardTrialOffers=${out.cardTrialOffers} ` +
        `skipped=${out.skipped}`,
    );
    return out;
  }

  /**
   * Users among `users` who showed intent to connect an app: their workspace
   * or they themselves have an INTENT_EVENTS event, or their sign-up came
   * through a channel other than 'direct' (attributedIntent). Only events of
   * the last 15 days are read: every candidate signed up within 14.
   */
  private async usersWithIntent(
    users: Array<{ id: string; organizationId: string | null }>,
    now: number,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (users.length === 0) return out;
    const userIds = users.map((u) => u.id);
    const orgIds = [...new Set(users.map((u) => u.organizationId).filter((id): id is string => !!id))];
    const who = [
      { userId: { in: userIds } },
      ...(orgIds.length > 0 ? [{ organizationId: { in: orgIds } }] : []),
    ];
    const createdAt = { gte: new Date(now - DAYS(15)) };
    const [actions, signups] = await Promise.all([
      this.prisma.productEvent.findMany({
        where: { event: { in: INTENT_EVENTS }, createdAt, OR: who },
        distinct: ['userId', 'organizationId'],
        select: { userId: true, organizationId: true },
      }),
      this.prisma.productEvent.findMany({
        where: { event: ProductEvents.SIGNUP_ATTRIBUTED, createdAt, OR: who },
        select: { userId: true, organizationId: true, metadata: true },
      }),
    ]);
    const intentUsers = new Set<string>();
    const intentOrgs = new Set<string>();
    for (const row of [...actions, ...signups.filter((r) => attributedIntent(r.metadata))]) {
      if (row.userId) intentUsers.add(row.userId);
      if (row.organizationId) intentOrgs.add(row.organizationId);
    }
    for (const u of users) {
      if (intentUsers.has(u.id) || (u.organizationId && intentOrgs.has(u.organizationId))) out.add(u.id);
    }
    return out;
  }

  /**
   * Records a reminder sent or withheld, with the user's reminder-1 arm, for
   * the per-arm report. Best-effort: a lost event never stops the drip (the
   * arm can be recomputed from the user id, see onboarding-reminder.ts).
   */
  private async reminderEvent(
    event: typeof ProductEvents.ONBOARDING_REMINDER_SENT | typeof ProductEvents.ONBOARDING_REMINDER_HOLDOUT,
    user: { id: string; organizationId: string | null },
    reminder: 1 | 2,
    arm: ReminderArm,
    kind?: 'generic' | 'ai_client',
  ): Promise<void> {
    try {
      await this.prisma.productEvent.create({
        data: {
          event,
          userId: user.id,
          organizationId: user.organizationId,
          metadata: { reminder, arm, ...(kind ? { kind } : {}) },
        },
      });
    } catch (err: any) {
      this.logger.warn(`Onboarding reminder event not recorded: ${err?.message ?? err}`);
    }
  }

  /**
   * Trial lifecycle pass — value-oriented conversion nudges as a trial winds
   * down. For each cloud trial whose `expiresAt` is within 3 days or already
   * past, send the most-urgent unsent stage (expired → warn1 → warn3) to the
   * org's admins, with a recap of what they've built. These are account-
   * lifecycle (paid access ending), not marketing, so they ignore the
   * marketing opt-out. Idempotent via per-org OrgSettings flags
   * (`trial_email_{stage}`). Sends at most one stage per org per run.
   *
   * Never to a workspace that already pays or is about to: a paid licence, a
   * card trial (bound here or not), a declined card still being retried
   * (LicenseService.workspacesWithPaidPlan). These emails link to the pricing
   * page, and on 14 Oct 2026 card-trial holders bought a second subscription
   * from them. Such a stage is left unflagged and decided again on the next
   * run while the trial is still selected here (the expired stage gets one
   * run: markExpiredTrials flips the trial right after it).
   *
   * The expired stage of a business workspace (winback-segment.ts) outside
   * the control group is the plain email from Matteo instead: what they
   * built, the one-click 7-day extension and the locked price, with codes
   * minted for the workspace. Admins who opted out of marketing, and every
   * admin when the codes cannot be minted (this stage gets one run), get the
   * standard notice. The control group gets the standard notice too.
   */
  private async runTrialLifecyclePass(
    now: number,
    out: {
      examined: number;
      trialWarn3: number;
      trialWarn1: number;
      trialExpired: number;
      trialExpiredBusiness?: number;
      trialEmailsWithheld: number;
      skipped: number;
    },
  ): Promise<void> {
    const trials = await this.prisma.license.findMany({
      where: {
        plan: 'trial',
        status: 'active',
        organizationId: { not: null },
        expiresAt: { not: null, lte: new Date(now + DAYS(3)) },
      },
      select: { organizationId: true, expiresAt: true },
    });

    // Workspaces with a stage to send, and their admins (authoritative membership).
    const due: Array<{
      organizationId: string;
      stage: 'warn3' | 'warn1' | 'expired';
      flagKey: string;
      daysLeft: number;
      expiresAt: Date;
      admins: Array<{ user: { email: string; name: string | null; emailMarketingOptOut?: boolean } }>;
    }> = [];
    for (const lic of trials) {
      const organizationId = lic.organizationId!;
      const expiresAt = lic.expiresAt!.getTime();
      out.examined++;

      // Ladder: most-urgent applicable stage that hasn't been sent yet.
      const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / DAYS(1)));
      const stage: 'warn3' | 'warn1' | 'expired' =
        now >= expiresAt ? 'expired' : daysLeft <= 1 ? 'warn1' : 'warn3';
      const flagKey = `trial_email_${stage}`;

      const already = await this.prisma.orgSettings.findUnique({
        where: { organizationId_key: { organizationId, key: flagKey } },
        select: { id: true },
      });
      if (already) {
        out.skipped++;
        continue;
      }

      const admins = await this.prisma.organizationMember.findMany({
        where: { organizationId, role: 'ADMIN', deactivatedAt: null },
        select: { user: { select: { email: true, name: true, emailMarketingOptOut: true } } },
      });
      if (admins.length === 0) {
        out.skipped++;
        continue;
      }
      due.push({ organizationId, stage, flagKey, daysLeft, expiresAt: lic.expiresAt!, admins });
    }
    if (due.length === 0) return;

    const paidPlan = await this.license.workspacesWithPaidPlan(
      due.map((d) => ({ organizationId: d.organizationId, adminEmails: d.admins.map((a) => a.user.email) })),
      new Date(now),
    );

    for (const { organizationId, stage, flagKey, daysLeft, expiresAt, admins } of due) {
      if (paidPlan.paid.has(organizationId)) {
        out.trialEmailsWithheld++;
        out.skipped++;
        continue;
      }
      // The licence site could not say whether an admin has a subscription:
      // nothing is sent yet, and the next hourly run asks again.
      if (paidPlan.unknown.has(organizationId)) {
        out.skipped++;
        continue;
      }

      // Value recap (cheap counts; trial window is 7d so audit isn't pruned).
      const [connectors, successfulCalls] = await Promise.all([
        this.prisma.connector.count({ where: { organizationId } }),
        this.prisma.toolInvocation.count({ where: { organizationId, status: 'SUCCESS' } }),
      ]);

      // Business workspaces get the personal email on the expiry day.
      const business =
        stage === 'expired'
          ? await this.businessExpiryEmail(organizationId, admins, { connectors, successfulCalls }, expiresAt)
          : null;

      let sentAny = false;
      for (const a of admins) {
        const ok =
          business && !a.user.emailMarketingOptOut
            ? await this.email.sendTrialEndedBusinessEmail(a.user.email, a.user.name || 'there', business)
            : await this.email.sendTrialLifecycleEmail(a.user.email, a.user.name || 'there', stage, {
                connectors,
                successfulCalls,
                daysLeft,
              });
        if (ok) sentAny = true;
      }
      if (sentAny && business && admins.some((a) => !a.user.emailMarketingOptOut)) {
        await this.flag(organizationId, WINBACK_OFFER_KEY, offerValue('business', 'locked', 'expired'));
        if (out.trialExpiredBusiness !== undefined) out.trialExpiredBusiness++;
      }

      if (sentAny) {
        await this.prisma.orgSettings.upsert({
          where: { organizationId_key: { organizationId, key: flagKey } },
          create: { organizationId, key: flagKey, value: new Date().toISOString() },
          update: { value: new Date().toISOString() },
        });
        if (stage === 'expired') out.trialExpired++;
        else if (stage === 'warn1') out.trialWarn1++;
        else out.trialWarn3++;
      } else {
        out.skipped++;
      }
    }
  }

  /**
   * Win-back pass (see WINBACK_STAGES). One email per stage and workspace,
   * flagged in OrgSettings like the lifecycle emails; a stage is only sent
   * inside its window, so a late run never mails a month-old trial its
   * first offer. Skips workspaces that are or were customers, and admins who
   * opted out of marketing email. A workspace that used the product and is in
   * the control group (winback-segment.ts) gets no offer: the stage is closed
   * and counted as winbackHoldout. Each offer sent is stored as
   * `winback_offer`. Waits a day after the blocked-call email.
   */
  private async runWinbackPass(
    now: number,
    out: {
      examined: number;
      winbackOffers: number;
      winbackHelp: number;
      winbackHoldout: number;
      skipped: number;
    },
  ): Promise<void> {
    const trials = await this.prisma.license.findMany({
      where: {
        plan: 'trial',
        status: { in: ['active', 'expired'] },
        organizationId: { not: null },
        expiresAt: { gte: WINBACK_FROM, lte: new Date(now - WINBACK_STAGES[0].after) },
      },
      select: { organizationId: true, expiresAt: true },
    });

    for (const lic of trials) {
      const organizationId = lic.organizationId!;
      const trialEndedAt = lic.expiresAt!;
      const endedFor = now - trialEndedAt.getTime();
      const step = WINBACK_STAGES.find((s) => endedFor >= s.after && endedFor < s.until);
      if (!step) continue;
      out.examined++;

      // Any licence besides the free trial, in any state, means the workspace
      // went through Stripe checkout: a paid plan, a card trial (plan
      // 'starter' while Stripe says trialing), or one since revoked or
      // expired. None of them gets a discount, nor the how-to.
      const [already, customer] = await Promise.all([
        this.prisma.orgSettings.findUnique({
          where: { organizationId_key: { organizationId, key: step.flagKey } },
          select: { id: true },
        }),
        this.prisma.license.count({ where: { organizationId, plan: { not: 'trial' } } }),
      ]);
      if (already) {
        out.skipped++;
        continue;
      }
      if (customer > 0) {
        await this.flag(organizationId, step.flagKey);
        out.skipped++;
        continue;
      }

      const [admins, successfulCalls] = await Promise.all([
        this.prisma.organizationMember.findMany({
          where: { organizationId, role: 'ADMIN', deactivatedAt: null },
          select: { user: { select: { email: true, name: true, emailMarketingOptOut: true } } },
        }),
        this.prisma.toolInvocation.count({ where: { organizationId, status: 'SUCCESS' } }),
      ]);
      const used = successfulCalls > 0;

      // Someone who never made a call gets the how-to once, in the first stage.
      if (!used && step.stage !== 'first') {
        await this.flag(organizationId, step.flagKey);
        out.skipped++;
        continue;
      }

      // Nobody to mail (no admin, all opted out) ends the stage.
      const recipients = admins.filter((a) => !a.user.emailMarketingOptOut).map((a) => a.user);
      if (recipients.length === 0) {
        await this.flag(organizationId, step.flagKey);
        out.skipped++;
        continue;
      }

      // Nor a workspace one of whose admins' addresses had a Stripe
      // subscription: a card trial or plan bought under it that never reached
      // this server (its licence not activated here) is as much a customer as
      // one that did. Neither email goes there: both link to the pricing page.
      // Without a complete answer from the licence site nothing is sent and
      // nothing flagged: the next hourly run asks again inside the window.
      const paidPlan = await this.license.workspacesWithPaidPlan(
        [{ organizationId, adminEmails: admins.map((a) => a.user.email) }],
        new Date(now),
      );
      if (paidPlan.unknown.has(organizationId)) {
        this.logger.warn(
          `Win-back for workspace ${organizationId} postponed: no subscription history from the licence site.`,
        );
        out.skipped++;
        continue;
      }
      if (paidPlan.paid.has(organizationId)) {
        await this.flag(organizationId, step.flagKey);
        out.skipped++;
        continue;
      }

      // Who the workspace is decides the holdout and the offer.
      // The how-to (never used) is no offer: never held out.
      let segment: WinbackSegment = 'unused';
      if (used) {
        const connectors = await this.prisma.connector.findMany({
          where: { organizationId },
          select: { config: true },
        });
        segment = winbackSegment({
          adminEmails: admins.map((a) => a.user.email),
          connectorConfigs: connectors.map((c) => c.config),
          successfulCalls,
        });
        // Not within a day of the blocked-call email: the next run inside the
        // window sends it.
        if (await this.winbackEmailSentWithin(organizationId, now, BLOCKED_CALLS.spacing)) {
          out.skipped++;
          continue;
        }
        if (await this.inHoldout(organizationId, segment)) {
          await this.flag(organizationId, step.flagKey);
          out.winbackHoldout++;
          out.skipped++;
          continue;
        }
      }

      let offer: WinbackOffer;
      if (!used) {
        offer = { kind: 'help', trialEndedAt };
      } else {
        // Fresh codes for each stage: the first ones expire after 14 days.
        // Without them nothing is sent or flagged: the next run asks again.
        const retention = await this.mintOffer(organizationId, segment);
        if (!retention) {
          out.skipped++;
          continue;
        }
        offer = { kind: 'offer', offer: retention, stage: step.stage, trialEndedAt, successfulCalls };
      }

      let sentAny = false;
      for (const r of recipients) {
        const ok = await this.email.sendTrialWinbackEmail(r.email, r.name || 'there', offer);
        if (ok) sentAny = true;
      }

      // A failed send does not end the stage: the next run retries inside the window.
      if (!sentAny) {
        out.skipped++;
        continue;
      }
      await this.flag(organizationId, step.flagKey);
      if (offer.kind === 'help') {
        await this.flag(organizationId, WINBACK_OFFER_KEY, offerValue(segment, 'help', step.stage));
        out.winbackHelp++;
        continue;
      }
      await this.flag(organizationId, WINBACK_OFFER_KEY, offerValue(segment, offer.offer.kind, step.stage));
      out.winbackOffers++;
    }
  }

  /**
   * What the expiry-day email of a business workspace needs, or null when the
   * workspace gets the standard notice: not business, in the control group,
   * no admin who takes marketing email, or no codes from the licence site.
   */
  private async businessExpiryEmail(
    organizationId: string,
    admins: Array<{ user: { email: string; emailMarketingOptOut?: boolean } }>,
    counts: { connectors: number; successfulCalls: number },
    trialEndedAt: Date,
  ): Promise<{
    recap: { connectors: number; successfulCalls: number; topConnector: string | null };
    extendUrl: string | null;
    offer: Extract<RetentionOffer, { kind: 'locked' }>;
  } | null> {
    if (!admins.some((a) => !a.user.emailMarketingOptOut)) return null;
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { config: true },
    });
    const segment = winbackSegment({
      adminEmails: admins.map((a) => a.user.email),
      connectorConfigs: connectors.map((c) => c.config),
      successfulCalls: counts.successfulCalls,
    });
    if (segment !== 'business') return null;
    if (await this.inHoldout(organizationId, segment)) return null;
    const offer = await this.mintOffer(organizationId, segment);
    if (offer?.kind !== 'locked') {
      this.logger.warn(`Business expiry email for workspace ${organizationId}: no codes, the standard notice goes out.`);
      return null;
    }
    const secret = trialExtensionSecret();
    const token = secret ? createTrialExtensionToken(organizationId, trialEndedAt, secret) : null;
    return {
      recap: { ...counts, topConnector: await this.topConnectorName(organizationId) },
      extendUrl: token ? `${cloudFrontendOrigin()}/api/license/extend?token=${encodeURIComponent(token)}` : null,
      offer,
    };
  }

  /** The connector with the most successful calls in the workspace, by name; null when none. */
  private async topConnectorName(organizationId: string): Promise<string | null> {
    const [top] = await this.prisma.toolInvocation.groupBy({
      by: ['connectorId'],
      where: { organizationId, status: 'SUCCESS', connectorId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { connectorId: 'desc' } },
      take: 1,
    });
    if (!top?.connectorId) return null;
    const connector = await this.prisma.connector.findUnique({
      where: { id: top.connectorId },
      select: { name: true },
    });
    return connector?.name ?? null;
  }

  /**
   * The segment's offer (RETENTION_OFFERS) with codes minted for this
   * workspace, or null when the licence site cannot give them now (the
   * caller then sends nothing and retries on a later run).
   */
  private async mintOffer(organizationId: string, segment: WinbackSegment): Promise<RetentionOffer | null> {
    if (!this.codes) return null;
    if (RETENTION_OFFERS[segment] === 'locked') {
      const [monthly, yearly] = await Promise.all([
        this.codes.winbackCode(organizationId, segment, 'locked-monthly'),
        this.codes.winbackCode(organizationId, segment, 'locked-yearly'),
      ]);
      if (!monthly || !yearly) return null;
      return {
        kind: 'locked',
        monthlyCode: monthly.code,
        yearlyCode: yearly.code,
        codesExpireAt: monthly.expiresAt < yearly.expiresAt ? monthly.expiresAt : yearly.expiresAt,
      };
    }
    const personal = await this.codes.winbackCode(organizationId, segment, 'personal-monthly');
    if (!personal) return null;
    return { kind: 'personal', code: personal.code, codesExpireAt: personal.expiresAt };
  }

  /**
   * Blocked-call pass (see BLOCKED_CALLS). For each workspace with at least
   * `minEvents` blocked-call events in the last `window`: its trial ended, it
   * never was a customer (the win-back's checks: any licence besides the free
   * trial, then the licence site's subscription history for every admin,
   * postponed when the site cannot answer), it has an admin who did not opt out of
   * marketing, it is not in the control group, and no win-back email went out
   * in the last day. The email says which app the AI tried and how often.
   *
   * Once per workspace: `trial_email_blocked_calls` is set when it is sent,
   * and whenever the workspace is ruled out for good (customer, nobody to
   * mail, control group). A workspace that never made a successful
   * call is included: an AI still calling after the trial is intent, and the
   * email says so in its own words. Sending also sets the first win-back's
   * flag. A postponed or failed send sets nothing: the next run decides again
   * while the events are inside the window.
   */
  private async runBlockedCallPass(
    now: number,
    out: { examined: number; blockedCallEmails: number; blockedCallHoldout: number; skipped: number },
  ): Promise<void> {
    const since = new Date(now - BLOCKED_CALLS.window);
    const groups = await this.prisma.productEvent.groupBy({
      by: ['organizationId'],
      where: {
        event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED,
        organizationId: { not: null },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });
    const firstStage = WINBACK_STAGES[0];
    for (const group of groups) {
      const organizationId = group.organizationId;
      if (!organizationId || group._count._all < BLOCKED_CALLS.minEvents) continue;
      out.examined++;

      const [already, customer, trial] = await Promise.all([
        this.prisma.orgSettings.findUnique({
          where: { organizationId_key: { organizationId, key: BLOCKED_CALLS.flagKey } },
          select: { id: true },
        }),
        this.prisma.license.count({ where: { organizationId, plan: { not: 'trial' } } }),
        this.prisma.license.findFirst({
          where: { organizationId, plan: 'trial' },
          orderBy: { createdAt: 'desc' },
          select: { expiresAt: true },
        }),
      ]);
      if (already) {
        out.skipped++;
        continue;
      }
      if (customer > 0) {
        await this.flag(organizationId, BLOCKED_CALLS.flagKey);
        out.skipped++;
        continue;
      }
      // The trial must still be over: one extended or reissued since the
      // events were recorded is not blocked any more.
      const trialEndedAt = trial?.expiresAt ?? null;
      if (!trialEndedAt || trialEndedAt.getTime() > now) {
        out.skipped++;
        continue;
      }

      const [admins, successfulCalls, connectors] = await Promise.all([
        this.prisma.organizationMember.findMany({
          where: { organizationId, role: 'ADMIN', deactivatedAt: null },
          select: { user: { select: { email: true, name: true, emailMarketingOptOut: true } } },
        }),
        this.prisma.toolInvocation.count({ where: { organizationId, status: 'SUCCESS' } }),
        this.prisma.connector.findMany({ where: { organizationId }, select: { config: true } }),
      ]);
      const segment = winbackSegment({
        adminEmails: admins.map((a) => a.user.email),
        connectorConfigs: connectors.map((c) => c.config),
        successfulCalls,
      });
      const recipients = admins.filter((a) => !a.user.emailMarketingOptOut).map((a) => a.user);
      if (recipients.length === 0) {
        await this.flag(organizationId, BLOCKED_CALLS.flagKey);
        out.skipped++;
        continue;
      }

      const paidPlan = await this.license.workspacesWithPaidPlan(
        [{ organizationId, adminEmails: admins.map((a) => a.user.email) }],
        new Date(now),
      );
      if (paidPlan.unknown.has(organizationId)) {
        this.logger.warn(
          `Blocked-call email for workspace ${organizationId} postponed: no subscription history from the licence site.`,
        );
        out.skipped++;
        continue;
      }
      if (paidPlan.paid.has(organizationId)) {
        await this.flag(organizationId, BLOCKED_CALLS.flagKey);
        out.skipped++;
        continue;
      }

      if (await this.winbackEmailSentWithin(organizationId, now, BLOCKED_CALLS.spacing)) {
        out.skipped++;
        continue;
      }
      if (await this.inHoldout(organizationId, segment)) {
        await this.flag(organizationId, BLOCKED_CALLS.flagKey);
        out.blockedCallHoldout++;
        out.skipped++;
        continue;
      }

      const offer = await this.mintOffer(organizationId, segment);
      if (!offer) {
        out.skipped++;
        continue;
      }
      const attempts = await this.blockedCallSummary(organizationId, since);
      let sentAny = false;
      for (const r of recipients) {
        const ok = await this.email.sendTrialBlockedCallsEmail(r.email, r.name || 'there', {
          ...attempts,
          neverUsed: segment === 'unused',
          offer,
          trialEndedAt,
        });
        if (ok) sentAny = true;
      }
      if (!sentAny) {
        out.skipped++;
        continue;
      }
      await this.flag(organizationId, BLOCKED_CALLS.flagKey);
      // It is the first win-back: that stage is not sent again.
      const firstSent = await this.prisma.orgSettings.findUnique({
        where: { organizationId_key: { organizationId, key: firstStage.flagKey } },
        select: { id: true },
      });
      if (!firstSent) await this.flag(organizationId, firstStage.flagKey);
      await this.flag(organizationId, WINBACK_OFFER_KEY, offerValue(segment, offer.kind, BLOCKED_CALLS.stage));
      out.blockedCallEmails++;
    }
  }

  /**
   * What the email reports from the blocked-call events since `since`: the
   * catalog app the AI tried most and how often, and the AI client named most
   * (null when none was recorded). Without any app, the count is of all the
   * events. Each event stands for at least one refused call (they are
   * throttled per tool and hour), so the number never overstates.
   */
  private async blockedCallSummary(
    organizationId: string,
    since: Date,
  ): Promise<{ attempts: number; appName: string | null; clientName: string | null }> {
    const rows = await this.prisma.productEvent.findMany({
      where: { event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED, organizationId, createdAt: { gte: since } },
      select: { metadata: true },
    });
    const top = (key: 'adapterSlug' | 'client'): [string, number] | null => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = (r.metadata as Record<string, unknown> | null)?.[key];
        if (typeof v === 'string' && v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      let best: [string, number] | null = null;
      for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
      return best;
    };
    const app = top('adapterSlug');
    const appName = app ? (getAdapter(app[0])?.name ?? null) : null;
    return {
      attempts: app && appName ? app[1] : rows.length,
      appName,
      clientName: top('client')?.[0] ?? null,
    };
  }

  /**
   * Whether a workspace is in the win-back control group (winback-segment.ts).
   * Decided once, the first time it is due an offer, and stored as
   * `winback_holdout`; the stored decision holds even if the segment changes.
   */
  private async inHoldout(organizationId: string, segment: WinbackSegment): Promise<boolean> {
    const stored = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: WINBACK_HOLDOUT_KEY } },
      select: { value: true },
    });
    if (stored) return isHoldoutValue(stored.value);
    const held = inWinbackHoldout(organizationId, segment);
    await this.flag(organizationId, WINBACK_HOLDOUT_KEY, holdoutValue(segment, held));
    return held;
  }

  /** Whether any win-back email (WINBACK_EMAIL_FLAGS) was flagged in the last `ms`. */
  private async winbackEmailSentWithin(organizationId: string, now: number, ms: number): Promise<boolean> {
    const recent = await this.prisma.orgSettings.findFirst({
      where: {
        organizationId,
        key: { in: WINBACK_EMAIL_FLAGS },
        updatedAt: { gt: new Date(now - ms) },
      },
      select: { id: true },
    });
    return !!recent;
  }

  /** Stores an OrgSettings value, by default the current time (a sent-flag). */
  private async flag(organizationId: string, key: string, value = new Date().toISOString()): Promise<void> {
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value },
      update: { value },
    });
  }

  /**
   * Flip trials past their `expiresAt` to `status = 'expired'`.
   *
   * Access was never the issue: the licence guard checks `expiresAt` at
   * request time, so an expired trial is blocked whether or not its status
   * says so. The column was simply never transitioned, and by September 2026
   * 1,021 of 1,094 "active" trials had in fact ended — every funnel query,
   * dashboard and export that grouped by status was wrong, and the count of
   * live trials was overstated by more than an order of magnitude. Runs after
   * the lifecycle pass, which selects on `status: 'active'`, so the "your
   * trial has ended" email still goes out before the flip.
   */
  private async markExpiredTrials(now: number): Promise<number> {
    const { count } = await this.prisma.license.updateMany({
      where: {
        plan: 'trial',
        status: 'active',
        expiresAt: { not: null, lt: new Date(now) },
      },
      data: { status: 'expired' },
    });
    if (count > 0) this.logger.log(`Marked ${count} trial(s) as expired`);
    return count;
  }

  /**
   * Activation pass — the cohort that builds a connector but never lands a
   * successful tool call (the biggest single drop-off). One email only,
   * 24h-14d after signup, linking straight to their connector's playground.
   * `firstSuccessfulInvocationAt: null` = never activated; `activationReminderAt`
   * caps it at one send.
   */
  /**
   * Users among `userIds` with a live AI-client connection, mapped to the
   * client's display name.
   */
  private async connectedAiClients(userIds: string[], now: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0) return out;
    const grants = await this.prisma.mcpConnectionGrant.findMany({
      where: {
        userId: { in: userIds },
        revokedAt: null,
        createdAt: { lte: new Date(now) },
      },
      select: { userId: true, clientId: true },
    });
    if (grants.length === 0) return out;
    const clients = await this.prisma.oAuthClient.findMany({
      where: { clientId: { in: [...new Set(grants.map((g) => g.clientId))] } },
      select: { clientId: true, clientName: true },
    });
    const names = new Map(clients.map((c) => [c.clientId, c.clientName]));
    for (const g of grants) {
      if (!out.has(g.userId)) out.set(g.userId, names.get(g.clientId) || 'your AI client');
    }
    return out;
  }

  private async runActivationPass(
    now: number,
    out: {
      examined: number;
      activationReminders: number;
      skipped: number;
    },
  ): Promise<void> {
    const stuck = await this.prisma.user.findMany({
      where: {
        emailVerified: true,
        emailMarketingOptOut: false,
        firstSuccessfulInvocationAt: null,
        activationReminderAt: null,
        createdAt: {
          lte: new Date(now - HOURS(24)),
          gte: new Date(now - HOURS(24 * 14)),
        },
        connectors: { some: {} },
      },
      select: {
        id: true,
        email: true,
        name: true,
        connectors: {
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        mcpServers: {
          select: { id: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const u of stuck) {
      out.examined++;
      // Median attach → first call is 12 minutes; a day of silence after
      // attaching means no client was ever connected (183 of the 246 stuck
      // workspaces never sent a request). Send those to the page that shows
      // their endpoint and the client instructions, not to the tool tester.
      const serverId = u.mcpServers[0]?.id;
      const connectorId = u.connectors[0]?.id;
      const path = serverId
        ? `/mcp-server/${serverId}`
        : connectorId
          ? `/connectors/${connectorId}`
          : '/connectors';
      const ok = await this.email.sendActivationReminderEmail(
        u.email,
        u.name || 'there',
        path,
        serverId ? 'connect-client' : 'test-connector',
      );
      if (ok) {
        await this.prisma.user.update({
          where: { id: u.id },
          data: { activationReminderAt: new Date() },
        });
        out.activationReminders++;
      } else {
        out.skipped++;
      }
    }
  }
}
