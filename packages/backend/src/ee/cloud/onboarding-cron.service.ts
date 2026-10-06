import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { EmailService } from '../../settings/email.service';
import { LicenseService } from '../../license/license.service';
import { LicenseReleaseService } from '../../license/license-release.service';

const HOURS = (n: number) => n * 60 * 60 * 1000;

/** How long after connecting an AI client to an empty workspace we nudge. */
const AI_CLIENT_NUDGE_AFTER = HOURS(2);
const DAYS = (n: number) => n * 24 * 60 * 60 * 1000;

/**
 * Win-back after a Cloud trial ends. Until 6 Oct 2026 the licence site sent
 * every Cloud trial the same 50% code a week and a month after expiry (about
 * 2,100 emails, one redemption): most of those people never connected an app.
 * The site has no usage data; this cron does, so Cloud trials are won back from
 * here and the site keeps the self-hosted ones.
 *
 * Someone who made a successful call gets 30% a week after expiry and 50% a
 * month after; someone who never did gets one email on how to connect an app
 * from the chat. Only trials that ended from WINBACK_FROM on: earlier ones were
 * already sent the site's win-back.
 */
const WINBACK_FROM = new Date('2026-10-06T00:00:00Z');
const WINBACK_STAGES = [
  { stage: 'winback7', after: DAYS(7), until: DAYS(14), percentOff: 30, codeEnv: 'WINBACK_FIRST_PROMO_CODE', code: 'START30', endedAgo: 'week' },
  { stage: 'winback30', after: DAYS(30), until: DAYS(37), percentOff: 50, codeEnv: 'WINBACK_FINAL_PROMO_CODE', code: 'WINBACK50', endedAgo: 'month' },
] as const;

/**
 * Onboarding drip — finds users who registered, verified their email,
 * but never created a connector, and nudges them via email at two
 * milestones:
 *
 *   day 1 (~24-48h after signup): first reminder
 *   day 2 (~72-96h after signup, ≥48h after the first): second reminder
 *
 * Cap is 2 emails. After that we leave them alone — we'd rather lose
 * an inactive trial than annoy someone enough to mark us as spam.
 *
 * State columns on users (migration 20260528100000):
 *   onboarding_completed_at      — null = wizard not yet finished
 *   onboarding_last_reminder_at  — last drip touch
 *   onboarding_reminder_count    — terminal at 2
 *   email_marketing_opt_out      — hard unsubscribe
 *
 * Idempotency: the cron is fine to re-run within a window — counters
 * + timing checks prevent duplicate sends. Worst case a missed run
 * sends a reminder a few hours late.
 */
@Injectable()
export class OnboardingCronService {
  private readonly logger = new Logger(OnboardingCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly license: LicenseService,
    private readonly licenseRelease: LicenseReleaseService,
  ) {}

  async run(): Promise<{
    examined: number;
    firstReminders: number;
    secondReminders: number;
    activationReminders: number;
    trialWarn3: number;
    trialWarn1: number;
    trialExpired: number;
    trialsMarkedExpired: number;
    trialsRepaired: number;
    licensesReverified: number;
    licensesDeactivated: number;
    licensesReleased: number;
    winbackOffers: number;
    winbackHelp: number;
    skipped: number;
  }> {
    const now = Date.now();
    const out = {
      examined: 0,
      firstReminders: 0,
      secondReminders: 0,
      activationReminders: 0,
      trialWarn3: 0,
      trialWarn1: 0,
      trialExpired: 0,
      trialsMarkedExpired: 0,
      trialsRepaired: 0,
      licensesReverified: 0,
      licensesDeactivated: 0,
      licensesReleased: 0,
      winbackOffers: 0,
      winbackHelp: 0,
      skipped: 0,
    };

    // Candidate set: verified, ≤2 reminders, not opted out, registered
    // between AI_CLIENT_NUDGE_AFTER and 14d ago. We bound at 14d so a user
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
          lte: new Date(now - AI_CLIENT_NUDGE_AFTER),
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

      // First nudge: 24h after signup, or as soon as an AI client has been
      // connected for AI_CLIENT_NUDGE_AFTER, whichever comes first. The
      // second one names the client, because that is what the user just did.
      const aiClient = aiClients.get(u.id);
      if (u.onboardingReminderCount === 0 && (age >= HOURS(24) || aiClient)) {
        const ok = await this.email.sendOnboardingReminderEmail(
          u.email,
          u.name || 'there',
          1,
          aiClient ? { aiClient } : undefined,
        );
        if (ok) {
          await this.prisma.user.update({
            where: { id: u.id },
            data: {
              onboardingReminderCount: 1,
              onboardingLastReminderAt: new Date(),
            },
          });
          out.firstReminders++;
        } else {
          out.skipped++;
        }
        continue;
      }

      // Second nudge: count == 1, ≥72h after signup AND ≥48h since first.
      if (
        u.onboardingReminderCount === 1 &&
        age >= HOURS(72) &&
        sinceLast >= HOURS(48)
      ) {
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
        `second=${out.secondReminders} activation=${out.activationReminders} ` +
        `trialWarn3=${out.trialWarn3} trialWarn1=${out.trialWarn1} trialExpired=${out.trialExpired} ` +
        `trialsMarkedExpired=${out.trialsMarkedExpired} trialsRepaired=${out.trialsRepaired} ` +
        `licensesReverified=${out.licensesReverified} licensesDeactivated=${out.licensesDeactivated} ` +
        `licensesReleased=${out.licensesReleased} winbackOffers=${out.winbackOffers} winbackHelp=${out.winbackHelp} ` +
        `skipped=${out.skipped}`,
    );
    return out;
  }

  /**
   * Trial lifecycle pass — value-oriented conversion nudges as a trial winds
   * down. For each cloud trial whose `expiresAt` is within 3 days or already
   * past, send the most-urgent unsent stage (expired → warn1 → warn3) to the
   * org's admins, with a recap of what they've built. These are account-
   * lifecycle (paid access ending), not marketing, so they ignore the
   * marketing opt-out. Idempotent via per-org OrgSettings flags
   * (`trial_email_{stage}`). Sends at most one stage per org per run.
   */
  private async runTrialLifecyclePass(
    now: number,
    out: { examined: number; trialWarn3: number; trialWarn1: number; trialExpired: number; skipped: number },
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

      // Recipients: org admins (authoritative membership).
      const admins = await this.prisma.organizationMember.findMany({
        where: { organizationId, role: 'ADMIN', deactivatedAt: null },
        select: { user: { select: { email: true, name: true } } },
      });
      if (admins.length === 0) {
        out.skipped++;
        continue;
      }

      // Value recap (cheap counts; trial window is 7d so audit isn't pruned).
      const [connectors, successfulCalls] = await Promise.all([
        this.prisma.connector.count({ where: { organizationId } }),
        this.prisma.toolInvocation.count({ where: { organizationId, status: 'SUCCESS' } }),
      ]);

      let sentAny = false;
      for (const a of admins) {
        const ok = await this.email.sendTrialLifecycleEmail(
          a.user.email,
          a.user.name || 'there',
          stage,
          { connectors, successfulCalls, daysLeft },
        );
        if (ok) sentAny = true;
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
   * one-week offer. Skips workspaces that bought a plan since, and admins who
   * opted out of marketing email.
   */
  private async runWinbackPass(
    now: number,
    out: { examined: number; winbackOffers: number; winbackHelp: number; skipped: number },
  ): Promise<void> {
    const trials = await this.prisma.license.findMany({
      where: {
        plan: 'trial',
        status: { in: ['active', 'expired'] },
        organizationId: { not: null },
        expiresAt: { gte: WINBACK_FROM, lte: new Date(now - DAYS(7)) },
      },
      select: { organizationId: true, expiresAt: true },
    });

    for (const lic of trials) {
      const organizationId = lic.organizationId!;
      const endedFor = now - lic.expiresAt!.getTime();
      const step = WINBACK_STAGES.find((s) => endedFor >= s.after && endedFor < s.until);
      if (!step) continue;
      out.examined++;
      const flagKey = `trial_email_${step.stage}`;

      const [already, paid] = await Promise.all([
        this.prisma.orgSettings.findUnique({
          where: { organizationId_key: { organizationId, key: flagKey } },
          select: { id: true },
        }),
        this.prisma.license.count({
          where: { organizationId, status: 'active', plan: { not: 'trial' } },
        }),
      ]);
      if (already || paid > 0) {
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

      // Someone who never made a call gets the how-to once, a week after.
      if (!used && step.stage !== 'winback7') {
        await this.flag(organizationId, flagKey);
        out.skipped++;
        continue;
      }

      const recipients = admins.filter((a) => !a.user.emailMarketingOptOut);
      let sentAny = false;
      for (const a of recipients) {
        const ok = await this.email.sendTrialWinbackEmail(
          a.user.email,
          a.user.name || 'there',
          used
            ? {
                kind: 'discount',
                percentOff: step.percentOff,
                promoCode: process.env[step.codeEnv] || step.code,
                endedAgo: step.endedAgo,
                successfulCalls,
              }
            : { kind: 'help' },
        );
        if (ok) sentAny = true;
      }

      // Nobody to mail (no admin, all opted out) ends the stage too; a failed
      // send does not, so the next run retries inside the window.
      if (sentAny || recipients.length === 0) await this.flag(organizationId, flagKey);
      if (!sentAny) out.skipped++;
      else if (used) out.winbackOffers++;
      else out.winbackHelp++;
    }
  }

  private async flag(organizationId: string, key: string): Promise<void> {
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
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
   * Users among `userIds` with a live AI-client connection made at least
   * AI_CLIENT_NUDGE_AFTER ago, mapped to the client's display name.
   */
  private async connectedAiClients(userIds: string[], now: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0) return out;
    const grants = await this.prisma.mcpConnectionGrant.findMany({
      where: {
        userId: { in: userIds },
        revokedAt: null,
        createdAt: { lte: new Date(now - AI_CLIENT_NUDGE_AFTER) },
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
