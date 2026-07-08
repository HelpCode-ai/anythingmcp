import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { EmailService } from '../../settings/email.service';

const HOURS = (n: number) => n * 60 * 60 * 1000;
const DAYS = (n: number) => n * 24 * 60 * 60 * 1000;

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
  ) {}

  async run(): Promise<{
    examined: number;
    firstReminders: number;
    secondReminders: number;
    activationReminders: number;
    trialWarn3: number;
    trialWarn1: number;
    trialExpired: number;
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
      skipped: 0,
    };

    // Candidate set: verified, no completion, ≤2 reminders, not opted out,
    // and registered between 24h and 14d ago. We bound at 14d so a user
    // who signed up months ago doesn't suddenly get woken up if we ever
    // backfill columns.
    const candidates = await this.prisma.user.findMany({
      where: {
        emailVerified: true,
        emailMarketingOptOut: false,
        onboardingCompletedAt: null,
        onboardingReminderCount: { lt: 2 },
        createdAt: {
          lte: new Date(now - HOURS(24)),
          gte: new Date(now - HOURS(24 * 14)),
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        onboardingReminderCount: true,
        onboardingLastReminderAt: true,
        _count: { select: { connectors: true } },
      },
    });

    for (const u of candidates) {
      out.examined++;

      // Race-safe: a user that created a connector between candidate
      // pull and now should never receive a nudge.
      if (u._count.connectors > 0) {
        // Auto-stamp completion so we never see them again.
        await this.prisma.user
          .update({
            where: { id: u.id },
            data: { onboardingCompletedAt: new Date() },
          })
          .catch(() => {});
        out.skipped++;
        continue;
      }

      const age = now - u.createdAt.getTime();
      const sinceLast = u.onboardingLastReminderAt
        ? now - u.onboardingLastReminderAt.getTime()
        : Infinity;

      // First nudge: 24-72h after signup, count == 0.
      if (u.onboardingReminderCount === 0 && age >= HOURS(24)) {
        const ok = await this.email.sendOnboardingReminderEmail(
          u.email,
          u.name || 'there',
          1,
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

    this.logger.log(
      `Onboarding drip: examined=${out.examined} first=${out.firstReminders} ` +
        `second=${out.secondReminders} activation=${out.activationReminders} ` +
        `trialWarn3=${out.trialWarn3} trialWarn1=${out.trialWarn1} trialExpired=${out.trialExpired} ` +
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
        where: { organizationId, role: 'ADMIN' },
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
   * Activation pass — the cohort that builds a connector but never lands a
   * successful tool call (the biggest single drop-off). One email only,
   * 24h-14d after signup, linking straight to their connector's playground.
   * `firstSuccessfulInvocationAt: null` = never activated; `activationReminderAt`
   * caps it at one send.
   */
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
      },
    });

    for (const u of stuck) {
      out.examined++;
      const connectorId = u.connectors[0]?.id;
      const path = connectorId ? `/connectors/${connectorId}` : '/connectors';
      const ok = await this.email.sendActivationReminderEmail(
        u.email,
        u.name || 'there',
        path,
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
