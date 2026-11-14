import { PlanFitService } from './plan-fit.service';
import { anonymizePlanFit, type FitPlan, type PlanFit } from './plan-fit';
import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { PAYWALL_ACTIONS, type PaywallAction, ProductEventService, ProductEvents } from '../audit/product-event.service';
import { LicenseService } from './license.service';
import { LicenseGuardService } from './license-guard.service';
import { LicenseWallService, knownClientName } from './license-wall.service';
import { readReactivationToken, type ReactivationTokenPayload } from './reactivation-token';
import { RetentionLicenceClient } from './retention-licence.client';
import {
  CHECKOUT_BILLING_PERIODS,
  CHECKOUT_PLANS,
  type CheckoutBillingPeriod,
  type CheckoutPlan,
  type CheckoutSource,
  PERSONAL_OFFER,
  type ReactivationOfferArm,
  cloudFrontendOrigin,
  reactivationOfferArm,
} from './license-checkout';

/** What the page shows, as the app's licence wall would (license-wall.tsx `reasonFor`). */
export type ReactivationState = 'trial-ended' | 'active' | 'payment-failed' | 'no-license';

export type ReactivationClient = 'Claude' | 'ChatGPT' | 'Cursor' | 'Copilot';

export interface ReactivationView {
  state: ReactivationState;
  workspaceName: string;
  /** When the free trial ended (ISO), for 'trial-ended'; null otherwise. */
  trialEndedAt: string | null;
  /**
   * The AI client the page names: the one whose tool call was blocked last
   * (the link came from its chat), else the first one the workspace
   * connected; null when neither is one we can name.
   */
  client: ReactivationClient | null;
  /** The workspace's current counts (GET /api/license/usage, without the caps). */
  usage: { connectors: number; mcpServers: number; users: number };
  /**
   * The Telegram price test (reactivationOfferArm): its arm for a workspace
   * that can buy and whose only connectors are Telegram bots, else null.
   */
  offerArm: ReactivationOfferArm | null;
  /** The discounted price shown in the 'personal' arm (Cloud Starter monthly); null otherwise. */
  offer: { plan: 'starter'; billingPeriod: 'monthly'; monthlyEur: number; months: number } | null;
  /**
   * What the workspace keeps and loses on each plan, without connector or
   * server names (the page opens without a sign-in); null when it could not
   * be read.
   */
  planFit: Record<FitPlan, PlanFit> | null;
}

/** The catalog adapter of the Telegram bot connector. */
const TELEGRAM_ADAPTER = 'telegram-bot';

export class ReactivationCheckoutDto {
  @IsIn(CHECKOUT_PLANS as unknown as string[])
  plan: CheckoutPlan;

  @IsIn(CHECKOUT_BILLING_PERIODS as unknown as string[])
  billingPeriod: CheckoutBillingPeriod;
}

/** A click on the page (paywall_action); plan and period as the page has them. */
export class ReactivationEventDto {
  @IsIn(PAYWALL_ACTIONS as unknown as string[])
  action: PaywallAction;

  @IsOptional()
  @IsIn(CHECKOUT_PLANS as unknown as string[])
  plan?: CheckoutPlan;

  @IsOptional()
  @IsIn(CHECKOUT_BILLING_PERIODS as unknown as string[])
  period?: CheckoutBillingPeriod;

  @IsOptional()
  @IsIn(['mobile', 'desktop'])
  device?: 'mobile' | 'desktop';

  /** The page's arm of the Telegram price test, as GET gave it. */
  @IsOptional()
  @IsIn(['personal', 'list'])
  offer?: ReactivationOfferArm;
}

/** The checkout source of every checkout opened from the page. */
export const REACTIVATE_CHECKOUT_SOURCE: CheckoutSource = 'mcp_reactivate';

const INVALID_LINK = 'This link is invalid or has expired.';

/**
 * The no-login reactivation page (`/reactivate/<token>` on the Cloud
 * frontend), the link an AI client gets in the 'page' arm of the
 * reactivation-link test when an ended trial blocks a tool call
 * (trialReactivationLink, license-checkout.ts). Cloud only: 404 on
 * self-hosted.
 *
 * - GET tells the page what to show: the workspace's state, name and counts.
 *   Never an address, a user or workspace id, or a licence key.
 * - POST opens a pay-now Stripe Checkout for the workspace's administrator,
 *   with the same refusals as POST /api/license/checkout-link. The paid
 *   licence names the workspace, so the unclaimed-licence sweep
 *   (license-unclaimed.ts) binds it within a few minutes even when nobody
 *   signs in afterwards.
 *
 * No session: the token (reactivation-token.ts) names the workspace and is
 * the only credential, as with the trial extension link.
 */
@ApiTags('License')
@Controller('api/license/reactivate')
export class ReactivationController {
  private readonly logger = new Logger(ReactivationController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly licenseService: LicenseService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly productEvents: ProductEventService,
    @Optional() private readonly licenseWall?: LicenseWallService,
    @Optional() private readonly retention?: RetentionLicenceClient,
    @Optional() private readonly planFit?: PlanFitService,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiParam({ name: 'token', description: 'The reactivation link token' })
  @ApiOperation({
    summary:
      "Cloud, no sign-in: the reactivation page's workspace state, name, AI client and counts (404 for an invalid or expired link)",
  })
  async view(@Param('token') token: string): Promise<ReactivationView> {
    const { organizationId } = this.check(token);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    if (!org) throw new NotFoundException(INVALID_LINK);

    const [{ state, trialEndedAt }, usage, client, fits] = await Promise.all([
      this.stateOf(organizationId),
      this.licenseGuard.getUsage(undefined, organizationId),
      this.clientOf(organizationId).catch(() => null),
      this.planFit ? this.planFit.fitAll(organizationId).catch(() => null) : Promise.resolve(null),
    ]);
    const planFit = fits
      ? { starter: anonymizePlanFit(fits.starter), team: anonymizePlanFit(fits.team) }
      : null;
    const offerArm = await this.offerArmOf(organizationId, state).catch(() => null);
    await this.recordView(organizationId, state, offerArm);
    return {
      offerArm,
      offer:
        offerArm === 'personal'
          ? {
              plan: PERSONAL_OFFER.plan,
              billingPeriod: PERSONAL_OFFER.billingPeriod,
              monthlyEur: PERSONAL_OFFER.monthlyEur,
              months: PERSONAL_OFFER.months,
            }
          : null,
      state,
      workspaceName: org.name,
      trialEndedAt: trialEndedAt ? trialEndedAt.toISOString() : null,
      client,
      usage: {
        connectors: usage.connectors.current,
        mcpServers: usage.mcpServers.current,
        users: usage.users.current,
      },
      planFit,
    };
  }

  @Post(':token/checkout')
  @HttpCode(200)
  // Each call mints a checkout intent on the licence site.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam({ name: 'token', description: 'The reactivation link token' })
  @ApiOperation({
    summary:
      "Cloud, no sign-in: a pay-now Stripe Checkout link for the workspace's administrator (409 when it already pays or a payment failed)",
  })
  async checkout(@Param('token') token: string, @Body() dto: ReactivationCheckoutDto): Promise<{ url: string }> {
    const link = this.check(token);
    const { organizationId } = link;
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw new NotFoundException(INVALID_LINK);

    // The same refusals as checkoutLink (license.controller.ts): a paying
    // workspace changes plan in the billing portal, and a failed payment is
    // resumed by updating the card, never by a second subscription.
    const current = await this.licenseService.getCurrentLicense(organizationId);
    if (current && current.plan !== 'trial' && current.status === 'active') {
      throw new ConflictException(
        'This workspace already has a subscription. Change your plan in the billing portal.',
      );
    }
    if (!(current && current.plan !== 'trial') && (await this.licenseService.getPaymentFailedLicense(organizationId))) {
      throw new ConflictException(
        'The last payment for this workspace did not go through. Update your payment method to resume your subscription.',
      );
    }

    const admin = await this.adminFor(link);
    if (!admin) {
      throw new ConflictException(
        'No administrator of this workspace was found. Sign in to the workspace to subscribe.',
      );
    }

    // The Telegram price test: the 'personal' arm buys Cloud Starter monthly
    // with its single-use code. Without a code the checkout is not opened at
    // the list price the page did not show; the visitor tries again.
    let promoCode: string | undefined;
    const offerArm =
      dto.plan === PERSONAL_OFFER.plan && dto.billingPeriod === PERSONAL_OFFER.billingPeriod
        ? // It can buy: the refusals above passed.
          await this.offerArmOf(organizationId, 'trial-ended').catch(() => null)
        : null;
    if (offerArm === 'personal') {
      const code = await this.retention?.winbackCode(organizationId, 'telegram', 'personal-monthly');
      if (!code) {
        this.logger.warn(`Reactivation checkout for org ${organizationId}: no Personal code from the licence site.`);
        throw new BadGatewayException('The checkout could not be opened right now. Please try again in a moment.');
      }
      promoCode = code.code;
    }

    try {
      // Never a card trial: the free trial is over, so this is a purchase.
      const { url } = await this.licenseService.createCheckoutIntent({
        email: admin.email,
        plan: `cloud_${dto.plan}`,
        billingPeriod: dto.billingPeriod,
        returnUrl: `${cloudFrontendOrigin()}/reactivate/${token}?paid=1`,
        organizationId,
        source: REACTIVATE_CHECKOUT_SOURCE,
        ...(promoCode && { promoCode }),
      });
      void this.productEvents.log({
        event: ProductEvents.CHECKOUT_LINK_CREATED,
        userId: admin.userId,
        organizationId,
        metadata: { via: REACTIVATE_CHECKOUT_SOURCE, kind: 'pay', ...(offerArm && { offer: offerArm }) },
      });
      return { url };
    } catch (err: any) {
      this.logger.warn(`Reactivation checkout for org ${organizationId} failed: ${err?.message ?? err}`);
      throw new BadGatewayException(
        'The checkout could not be opened right now. Please try again in a moment.',
      );
    }
  }

  @Post(':token/event')
  @HttpCode(204)
  // A page load reports 'shown', a few clicks and at most one leave.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiParam({ name: 'token', description: 'The reactivation link token' })
  @ApiOperation({
    summary: 'Cloud, no sign-in: record a click on the reactivation page (404 for an invalid or expired link)',
  })
  async event(@Param('token') token: string, @Body() dto: ReactivationEventDto): Promise<void> {
    const { organizationId, userId } = this.check(token);
    await this.productEvents.log({
      event: ProductEvents.PAYWALL_ACTION,
      userId: userId ?? null,
      organizationId,
      metadata: {
        source: REACTIVATE_CHECKOUT_SOURCE,
        variant: 'page',
        action: dto.action,
        plan: dto.plan,
        period: dto.period,
        device: dto.device,
        offer: dto.offer,
      },
    });
  }

  /** The token's workspace and user; 404 off Cloud and for anything invalid. */
  private check(token: unknown): ReactivationTokenPayload {
    if (!this.deployment.isCloud()) throw new NotFoundException();
    const payload = readReactivationToken(token);
    if (!payload) throw new NotFoundException(INVALID_LINK);
    return payload;
  }

  /**
   * The workspace's state as GET /api/license/status and the app's wall see
   * it. A lapsed paid licence (no failed payment pending) has no state of its
   * own here: it can buy again, so it is 'no-license' like a workspace that
   * never had one.
   */
  async stateOf(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<{ state: ReactivationState; trialEndedAt: Date | null }> {
    const current = await this.licenseService.getCurrentLicense(organizationId);
    if (current && current.plan !== 'trial') return { state: 'active', trialEndedAt: null };
    const currentEnd = current?.expiresAt ? new Date(current.expiresAt) : null;
    if (current && (!currentEnd || currentEnd.getTime() > now.getTime())) {
      return { state: 'active', trialEndedAt: null };
    }
    // No active licence, or a trial whose time ran out: a card trial is
    // charged when the free trial ends, so a declined payment comes first.
    if (await this.licenseService.getPaymentFailedLicense(organizationId)) {
      return { state: 'payment-failed', trialEndedAt: null };
    }
    if (current) return { state: 'trial-ended', trialEndedAt: currentEnd };
    const last = await this.licenseService.getLatestInactiveLicense(organizationId);
    if (last?.plan === 'trial') {
      return { state: 'trial-ended', trialEndedAt: last.expiresAt ? new Date(last.expiresAt) : null };
    }
    return { state: 'no-license', trialEndedAt: null };
  }

  /**
   * Who the checkout is for: the token's user when still an active
   * administrator of the workspace, else its longest-standing active
   * administrator. Null when it has none.
   */
  /**
   * The AI client to name on the page. The link is shown by the client whose
   * tool call was blocked, so its OAuth client (`metadata.client` on the
   * latest `trial_expired_call_blocked`, last 30 days) comes first; the first
   * client the workspace connected is the fallback.
   */
  private async clientOf(organizationId: string): Promise<ReactivationClient | null> {
    const blocked = await this.prisma.productEvent.findFirst({
      where: {
        organizationId,
        event: ProductEvents.TRIAL_EXPIRED_CALL_BLOCKED,
        createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const fromBlocked = knownClientName((blocked?.metadata as Record<string, unknown> | null)?.client);
    const name = fromBlocked ?? (await this.licenseWall?.connectedClient(organizationId)) ?? null;
    return name === 'Claude' || name === 'ChatGPT' || name === 'Cursor' || name === 'Copilot' ? name : null;
  }

  private async adminFor(link: ReactivationTokenPayload): Promise<{ userId: string; email: string } | null> {
    if (link.userId) {
      const member = await this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: link.userId, organizationId: link.organizationId } },
        select: { userId: true, role: true, deactivatedAt: true, user: { select: { email: true } } },
      });
      if (member && member.role === 'ADMIN' && !member.deactivatedAt && member.user?.email) {
        return { userId: member.userId, email: member.user.email };
      }
    }
    const admin = await this.prisma.organizationMember.findFirst({
      where: { organizationId: link.organizationId, role: 'ADMIN', deactivatedAt: null },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      select: { userId: true, user: { select: { email: true } } },
    });
    return admin?.user?.email ? { userId: admin.userId, email: admin.user.email } : null;
  }

  /**
   * The workspace's arm of the Telegram price test: only a workspace that can
   * buy (an ended trial or no licence), with at least one connector and only
   * Telegram bot connectors from the catalog. Null for everyone else.
   */
  private async offerArmOf(organizationId: string, state: ReactivationState): Promise<ReactivationOfferArm | null> {
    if (state !== 'trial-ended' && state !== 'no-license') return null;
    const connectors = await this.prisma.connector.findMany({
      where: { organizationId },
      select: { config: true },
      take: 50,
    });
    if (connectors.length === 0) return null;
    const telegramOnly = connectors.every(
      (c) => (c.config as Record<string, unknown> | null)?.adapterSlug === TELEGRAM_ADAPTER,
    );
    return telegramOnly ? reactivationOfferArm(organizationId) : null;
  }

  /** One `reactivate_page_viewed` per workspace a UTC day; never throws. */
  private async recordView(
    organizationId: string,
    state: ReactivationState,
    offerArm: ReactivationOfferArm | null = null,
  ): Promise<void> {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const seen = await this.prisma.productEvent.findFirst({
        where: { organizationId, event: ProductEvents.REACTIVATE_PAGE_VIEWED, createdAt: { gte: startOfDay } },
        select: { id: true },
      });
      if (seen) return;
      await this.productEvents.log({
        event: ProductEvents.REACTIVATE_PAGE_VIEWED,
        organizationId,
        userId: null,
        metadata: { state, ...(offerArm && { offer: offerArm }) },
      });
    } catch (err: any) {
      this.logger.warn(`reactivate_page_viewed not recorded: ${err?.message ?? err}`);
    }
  }
}
