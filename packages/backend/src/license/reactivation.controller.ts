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
import { IsIn } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';
import { LicenseService } from './license.service';
import { LicenseGuardService } from './license-guard.service';
import { LicenseWallService, knownClientName } from './license-wall.service';
import { readReactivationToken, type ReactivationTokenPayload } from './reactivation-token';
import {
  CHECKOUT_BILLING_PERIODS,
  CHECKOUT_PLANS,
  type CheckoutBillingPeriod,
  type CheckoutPlan,
  type CheckoutSource,
  cloudFrontendOrigin,
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
}

export class ReactivationCheckoutDto {
  @IsIn(CHECKOUT_PLANS as unknown as string[])
  plan: CheckoutPlan;

  @IsIn(CHECKOUT_BILLING_PERIODS as unknown as string[])
  billingPeriod: CheckoutBillingPeriod;
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

    const [{ state, trialEndedAt }, usage, client] = await Promise.all([
      this.stateOf(organizationId),
      this.licenseGuard.getUsage(undefined, organizationId),
      this.clientOf(organizationId).catch(() => null),
    ]);
    await this.recordView(organizationId, state);
    return {
      state,
      workspaceName: org.name,
      trialEndedAt: trialEndedAt ? trialEndedAt.toISOString() : null,
      client,
      usage: {
        connectors: usage.connectors.current,
        mcpServers: usage.mcpServers.current,
        users: usage.users.current,
      },
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

    try {
      // Never a card trial: the free trial is over, so this is a purchase.
      const { url } = await this.licenseService.createCheckoutIntent({
        email: admin.email,
        plan: `cloud_${dto.plan}`,
        billingPeriod: dto.billingPeriod,
        returnUrl: `${cloudFrontendOrigin()}/reactivate/${token}?paid=1`,
        organizationId,
        source: REACTIVATE_CHECKOUT_SOURCE,
      });
      void this.productEvents.log({
        event: ProductEvents.CHECKOUT_LINK_CREATED,
        userId: admin.userId,
        organizationId,
        metadata: { via: REACTIVATE_CHECKOUT_SOURCE, kind: 'pay' },
      });
      return { url };
    } catch (err: any) {
      this.logger.warn(`Reactivation checkout for org ${organizationId} failed: ${err?.message ?? err}`);
      throw new BadGatewayException(
        'The checkout could not be opened right now. Please try again in a moment.',
      );
    }
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

  /** One `reactivate_page_viewed` per workspace a UTC day; never throws. */
  private async recordView(organizationId: string, state: ReactivationState): Promise<void> {
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
        metadata: { state },
      });
    } catch (err: any) {
      this.logger.warn(`reactivate_page_viewed not recorded: ${err?.message ?? err}`);
    }
  }
}
