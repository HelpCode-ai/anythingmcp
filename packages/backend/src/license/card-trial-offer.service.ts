import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { EmailService } from '../settings/email.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import {
  FIRST_SUCCESS_SOURCE,
  OFFER_ELIGIBLE_KEY,
  OFFER_EMAIL_AFTER_MS,
  OFFER_EMAIL_KEY,
  OFFER_EMAIL_QUIET_MS,
  OFFER_EMAIL_UNTIL_MS,
  OTHER_TRIAL_EMAIL_KEYS,
  OfferLicence,
  cardTrialStillAvailable,
  offerLicenceState,
  offerTrialEnd,
  pickNextSteps,
} from './card-trial-offer';

/** What the app shows an admin of an eligible workspace. */
export interface CardTrialOffer {
  /** The connector of the first successful call; null when it is gone. */
  connectorName: string | null;
  /** When the free trial (and so the card trial) ends, ISO. */
  trialEndsAt: string;
}

export interface CardTrialOfferEmailRun {
  /** Eligible workspaces inside the email window. */
  examined: number;
  sent: number;
  /** Settled without an email: no longer eligible, or nobody to write to. */
  skipped: number;
  /** Another email went out less than 12 hours ago; the next run asks again. */
  postponed: number;
  /** Every send failed; the next run tries again inside the window. */
  failed: number;
}

/** Tools read per connector to suggest next steps; plenty for three picks. */
const MAX_TOOLS_READ = 60;

/**
 * The card-trial offer after the first success (card-trial-offer.ts), Cloud
 * only: what the app shows (currentOffer) and the one email (runEmailPass,
 * called hourly by the Cloud onboarding cron).
 *
 * Nothing here is ever part of an MCP tool response: the offer lives in the
 * app and in one email, per the Claude directory policy (no promotion inside
 * what the model receives).
 */
@Injectable()
export class CardTrialOfferService {
  private readonly logger = new Logger(CardTrialOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly email: EmailService,
    private readonly productEvents: ProductEventService,
  ) {}

  /**
   * The offer for this signed-in user, or null. Only admins (the only role
   * that can start a subscription), only on Cloud, only while the workspace
   * is eligible and a card trial can still start (48 h of trial left).
   */
  async currentOffer(
    organizationId: string | null | undefined,
    role: string | null | undefined,
    now: Date = new Date(),
  ): Promise<CardTrialOffer | null> {
    if (!this.deployment.isCloud() || !organizationId || role !== 'ADMIN') return null;
    const eligible = await this.prisma.orgSettings.findUnique({
      where: { organizationId_key: { organizationId, key: OFFER_ELIGIBLE_KEY } },
      select: { id: true },
    });
    if (!eligible) return null;

    const trialEndsAt = offerTrialEnd(await this.licences(organizationId), now);
    if (!cardTrialStillAvailable(trialEndsAt, now)) return null;

    const { connector } = await this.firstSuccessConnector(organizationId);
    return { connectorName: connector?.name ?? null, trialEndsAt: trialEndsAt!.toISOString() };
  }

  /**
   * One email per eligible workspace, to its active, verified admins who did
   * not opt out of these emails, between 30 minutes and 48 hours after it
   * became eligible (the cron runs hourly, so 30 to 90 minutes in practice).
   *
   * - Sent once: OrgSettings `card_trial_offer_email` is set when it went
   *   out, and when it never will (no longer eligible, nobody to write to).
   * - Re-checked at send time: a workspace that started a card trial, pays,
   *   or whose trial ended in the meantime gets nothing.
   * - Quiet: not within 12 hours of a trial-lifecycle or win-back email to the
   *   workspace, or an onboarding or activation nudge to one of its admins.
   *   Postponed, not dropped; past 48 hours it is dropped.
   *
   * Deleted workspaces take their events and settings with them, so they are
   * never selected. Never throws: a failure is logged and counted.
   */
  async runEmailPass(now: Date = new Date()): Promise<CardTrialOfferEmailRun> {
    const out: CardTrialOfferEmailRun = { examined: 0, sent: 0, skipped: 0, postponed: 0, failed: 0 };
    if (!this.deployment.isCloud()) return out;

    let events: Array<{ organizationId: string | null }>;
    try {
      events = await this.prisma.productEvent.findMany({
        where: {
          event: ProductEvents.CARD_TRIAL_OFFER_ELIGIBLE,
          createdAt: {
            gte: new Date(now.getTime() - OFFER_EMAIL_UNTIL_MS),
            lte: new Date(now.getTime() - OFFER_EMAIL_AFTER_MS),
          },
        },
        select: { organizationId: true },
      });
    } catch (err: any) {
      this.logger.warn(`Card-trial offer emails: could not read eligible workspaces: ${err?.message ?? err}`);
      return out;
    }

    const orgIds = [...new Set(events.map((e) => e.organizationId).filter((id): id is string => !!id))];
    for (const organizationId of orgIds) {
      try {
        const result = await this.emailWorkspace(organizationId, now);
        if (result === 'already') continue;
        out.examined++;
        out[result]++;
      } catch (err: any) {
        out.examined++;
        out.failed++;
        this.logger.warn(`Card-trial offer email for ${organizationId} failed: ${err?.message ?? err}`);
      }
    }
    if (out.examined > 0) {
      this.logger.log(
        `Card-trial offer emails: examined=${out.examined} sent=${out.sent} skipped=${out.skipped} ` +
          `postponed=${out.postponed} failed=${out.failed}`,
      );
    }
    return out;
  }

  private async emailWorkspace(
    organizationId: string,
    now: Date,
  ): Promise<'already' | 'sent' | 'skipped' | 'postponed' | 'failed'> {
    const flags = await this.prisma.orgSettings.findMany({
      where: { organizationId, key: { in: [OFFER_EMAIL_KEY, ...OTHER_TRIAL_EMAIL_KEYS] } },
      select: { key: true, updatedAt: true },
    });
    if (flags.some((f) => f.key === OFFER_EMAIL_KEY)) return 'already';

    const licences = await this.licences(organizationId);
    const state = offerLicenceState(licences, now);
    if (state !== 'eligible') {
      await this.settle(organizationId, `skipped:${state}`);
      return 'skipped';
    }

    const quietSince = now.getTime() - OFFER_EMAIL_QUIET_MS;
    if (flags.some((f) => f.updatedAt.getTime() >= quietSince)) return 'postponed';

    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null },
      select: {
        user: {
          select: {
            email: true,
            name: true,
            emailVerified: true,
            emailMarketingOptOut: true,
            onboardingLastReminderAt: true,
            activationReminderAt: true,
          },
        },
      },
    });
    const recipients = admins.map((a) => a.user).filter((u) => u.emailVerified && !u.emailMarketingOptOut);
    if (recipients.length === 0) {
      await this.settle(organizationId, 'skipped:no_recipient');
      return 'skipped';
    }
    const nudgedRecently = recipients.some((u) =>
      [u.onboardingLastReminderAt, u.activationReminderAt].some((at) => !!at && at.getTime() >= quietSince),
    );
    if (nudgedRecently) return 'postponed';

    const trialEndsAt = offerTrialEnd(licences, now)!;
    const cardTrial = cardTrialStillAvailable(trialEndsAt, now);
    const { connector, toolName } = await this.firstSuccessConnector(organizationId, true);
    const nextSteps = pickNextSteps(connector?.tools ?? [], toolName);
    const ctaPath = cardTrial
      ? `/start-trial?source=${FIRST_SUCCESS_SOURCE}`
      : `/settings/license?source=${FIRST_SUCCESS_SOURCE}`;

    let sentAny = false;
    for (const r of recipients) {
      const ok = await this.email.sendCardTrialOfferEmail(r.email, {
        name: r.name || 'there',
        connectorName: connector?.name ?? null,
        nextSteps,
        trialEndsAt,
        cardTrial,
        ctaPath,
      });
      if (ok) sentAny = true;
    }
    // A failed send does not settle it: the next run retries inside the window.
    if (!sentAny) return 'failed';

    await this.settle(organizationId, now.toISOString());
    await this.productEvents.log({
      event: ProductEvents.CARD_TRIAL_OFFER_EMAILED,
      organizationId,
      metadata: {
        ...(connector?.id && { connectorId: connector.id }),
        kind: cardTrial ? 'trial' : 'plan',
      },
    });
    return 'sent';
  }

  private async licences(organizationId: string): Promise<OfferLicence[]> {
    return this.prisma.license.findMany({
      where: { organizationId },
      select: { plan: true, status: true, expiresAt: true, createdAt: true },
    });
  }

  /** The connector (scoped to the workspace) and tool of the call that made it eligible. */
  private async firstSuccessConnector(
    organizationId: string,
    withTools = false,
  ): Promise<{
    connector: { id: string; name: string; tools?: Array<{ name: string; description: string }> } | null;
    toolName: string | null;
  }> {
    const event = await this.prisma.productEvent.findFirst({
      where: { organizationId, event: ProductEvents.CARD_TRIAL_OFFER_ELIGIBLE },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    const meta = (event?.metadata ?? {}) as { connectorId?: unknown; toolName?: unknown };
    const toolName = typeof meta.toolName === 'string' ? meta.toolName : null;
    if (typeof meta.connectorId !== 'string') return { connector: null, toolName };
    const connector = await this.prisma.connector.findFirst({
      where: { id: meta.connectorId, organizationId },
      select: {
        id: true,
        name: true,
        ...(withTools && {
          tools: {
            where: { isEnabled: true, deprecatedAt: null },
            select: { name: true, description: true },
            orderBy: { createdAt: 'asc' },
            take: MAX_TOOLS_READ,
          },
        }),
      },
    });
    return { connector: connector ?? null, toolName };
  }

  private async settle(organizationId: string, value: string): Promise<void> {
    await this.prisma.orgSettings.upsert({
      where: { organizationId_key: { organizationId, key: OFFER_EMAIL_KEY } },
      create: { organizationId, key: OFFER_EMAIL_KEY, value },
      update: { value },
    });
  }
}
