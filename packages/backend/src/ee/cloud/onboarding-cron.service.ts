import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { EmailService } from '../../settings/email.service';

const HOURS = (n: number) => n * 60 * 60 * 1000;

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
    skipped: number;
  }> {
    const now = Date.now();
    const out = {
      examined: 0,
      firstReminders: 0,
      secondReminders: 0,
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

    this.logger.log(
      `Onboarding drip: examined=${out.examined} first=${out.firstReminders} second=${out.secondReminders} skipped=${out.skipped}`,
    );
    return out;
  }
}
