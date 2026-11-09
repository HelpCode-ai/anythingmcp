import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity, ApiExcludeEndpoint } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEmail, IsIn, IsString, IsOptional, Matches, MaxLength, ValidateIf } from 'class-validator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { LicenseService, type BillingPortalFlow } from './license.service';
import { LicenseGuardService } from './license-guard.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';
import { CardTrialEligibilityService } from './card-trial-eligibility.service';
import { CardTrialOfferService } from './card-trial-offer.service';
import { LicenseWallService, type LicenseWallView } from './license-wall.service';
import { InvoiceEmailError, InvoiceEmailService } from './invoice-email.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { PlanFitService } from './plan-fit.service';
import { isFitPlan, type FitPlan, type PlanFit } from './plan-fit';
import { createEmailLinkToken } from '../common/email-link-token';
import {
  CHECKOUT_BILLING_PERIODS,
  CHECKOUT_PLANS,
  CHECKOUT_SOURCES,
  CheckoutBillingPeriod,
  CheckoutPlan,
  CheckoutSource,
  DEFAULT_CHECKOUT_SOURCE,
  cardTrialEnd,
  checkoutAdMetadata,
  cloudFrontendOrigin,
} from './license-checkout';

type CardTrialOfferView = { connectorName: string | null; trialEndsAt: string };

class SetLicenseKeyDto {
  @IsString()
  @Matches(/^AMCP-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}$/, {
    message: 'Invalid license key format. Expected: AMCP-XXXX-XXXX-XXXX-XXXX',
  })
  licenseKey: string;
}

export class CheckoutLinkDto {
  @IsIn(CHECKOUT_PLANS as unknown as string[])
  plan: CheckoutPlan;

  @IsIn(CHECKOUT_BILLING_PERIODS as unknown as string[])
  billingPeriod: CheckoutBillingPeriod;

  @IsBoolean()
  trial: boolean;

  // A Stripe promotion code the user arrived with (promo bar → sign-up). The
  // licence site pre-applies it when it is a live code and ignores it if not.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  promo?: string;

  // Where in the app the checkout was started (e.g. 'first_success_banner',
  // the card-trial offer after the first successful tool call). Lands in
  // Stripe metadata as checkout_source; 'app' when the page does not say.
  @IsOptional()
  @IsIn(CHECKOUT_SOURCES as unknown as string[])
  source?: CheckoutSource;
}

class BillingPortalDto {
  @IsOptional()
  @IsString()
  returnUrl?: string;

  /**
   * 'cancel': open Stripe's cancellation page directly;
   * 'payment_method_update': the page to add a card.
   */
  @IsOptional()
  @IsIn(['cancel', 'payment_method_update'])
  flow?: BillingPortalFlow;
}

class DpaLinkDto {
  /** The page language on the licence site (its locales); defaults to English. */
  @IsOptional()
  @IsIn(['en', 'de', 'it', 'es', 'zh', 'ja', 'ru'])
  locale?: string;
}

/**
 * Invoices by email. `to` is the recipient: absent keeps the current one,
 * null or '' goes back to the billing contact, an address sets that address.
 * There is no workspace or licence field: both come from the session.
 */
export class InvoiceEmailDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @ValidateIf((o) => typeof o.to === 'string' && o.to !== '')
  @IsString()
  @MaxLength(254)
  @IsEmail({}, { message: 'Invalid email address' })
  to?: string | null;
}

@ApiTags('License')
@Controller('api/license')
export class LicenseController {
  private readonly logger = new Logger(LicenseController.name);

  constructor(
    private readonly licenseService: LicenseService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly deployment: DeploymentService,
    private readonly productEvents: ProductEventService,
    private readonly cardTrialEligibility: CardTrialEligibilityService,
    private readonly cardTrialOffer: CardTrialOfferService,
    @Optional() private readonly licenseWall?: LicenseWallService,
    @Optional() private readonly invoiceEmail?: InvoiceEmailService,
    @Optional() private readonly securityEvents?: SecurityEventService,
    @Optional() private readonly planFit?: PlanFitService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current license status (optional auth for org-scoped results)' })
  async getStatus(@Req() req: any) {
    // Optional auth: extract organizationId from JWT if present
    let organizationId: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.authService.verifyToken(authHeader.substring(7));
        organizationId = payload.organizationId ?? undefined;
      } catch {}
    }

    // In cloud mode, require auth — don't leak license status to unauthenticated users
    if (this.deployment.isCloud() && !organizationId) {
      return { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
    }

    const license = await this.licenseService.getCurrentLicense(organizationId);

    // Cloud: a paid licence stopped on a declined card while Stripe still
    // retries the subscription. Reported ahead of a free trial that has run
    // out (a card trial is charged when the free trial ends), so the app asks
    // for a new card instead of selling a second subscription.
    if (
      this.deployment.isCloud() &&
      organizationId &&
      (!license || (license.plan === 'trial' && trialDaysLeftOf(license) === 0))
    ) {
      const failed = await this.licenseService.getPaymentFailedLicense(organizationId);
      if (failed) {
        return {
          plan: failed.plan,
          status: failed.status,
          features: null,
          expiresAt: failed.expiresAt,
          instanceId: null,
          paymentFailed: true,
          billing: failed.billing,
        };
      }
    }

    if (!license) {
      // Cloud: a workspace whose trial ran out (or whose paid licence lapsed)
      // has no active licence, but it is not a workspace that never had one.
      // Report the latest licence's plan and status so the app can say "your
      // trial has ended" and offer the plans, instead of "start a free trial"
      // (a trial the licence site will not grant a second time). Reporting
      // only: no features, and gating still uses the active licence alone.
      const last =
        this.deployment.isCloud() && organizationId
          ? await this.licenseService.getLatestInactiveLicense(organizationId)
          : null;
      if (last) {
        return {
          plan: last.plan,
          status: last.status,
          features: null,
          expiresAt: last.expiresAt,
          instanceId: null,
          ...(last.plan === 'trial' && { trialDaysLeft: 0 }),
        };
      }
      return { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
    }

    const trialDaysLeft = trialDaysLeftOf(license);

    return {
      plan: license.plan,
      status: license.status,
      features: license.features,
      expiresAt: license.expiresAt,
      lastVerifiedAt: license.lastVerifiedAt,
      instanceId: license.instanceId,
      ...(trialDaysLeft !== undefined && { trialDaysLeft }),
      // Cloud, paid licences: the subscription's state (card trial end, set
      // to cancel at period end, next renewal and price).
      ...(license.billing && { billing: license.billing }),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Re-verify the workspace licence now, e.g. after returning from the billing portal (cloud, ADMIN)',
  })
  async refresh(@Req() req: any): Promise<{ refreshed: boolean }> {
    if (!this.deployment.isCloud()) throw new NotFoundException();
    const refreshed = await this.licenseService
      .refreshLicense(req.user.organizationId)
      .catch(() => false);
    return { refreshed };
  }

  @Post('sync')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async syncFromSite(@Req() req: any, @Body() dto: SetLicenseKeyDto): Promise<{ synced: boolean }> {
    // Called by the licence site from its Stripe webhook when a licence
    // changes. Only the site holds the shared service token; anyone else,
    // and every self-hosted server, gets a 404.
    if (!this.deployment.isCloud() || !serviceTokenMatches(req.headers?.['x-amcp-service-token'])) {
      throw new NotFoundException();
    }
    const synced = await this.licenseService.syncFromSite(dto.licenseKey).catch((err) => {
      this.logger.warn(`Licence sync failed: ${err?.message ?? err}`);
      return false;
    });
    return { synced };
  }

  @Get('instance-id')
  @ApiOperation({ summary: 'Get the instance ID' })
  async getInstanceId() {
    const instanceId = await this.licenseService.getInstanceId();
    return { instanceId };
  }

  @Get('usage')
  @ApiOperation({
    summary:
      'Current usage vs caps for the org. Drives the soft-warn upgrade banner in the UI.',
  })
  async getUsage(@Req() req: any) {
    // Optional auth — anonymous self-hosted single-user instances still get
    // their global usage. Cloud requires an org-scoped JWT.
    let organizationId: string | undefined;
    let userId: string | undefined;
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.authService.verifyToken(authHeader.substring(7));
        organizationId = payload.organizationId ?? undefined;
        userId = payload.sub ?? undefined;
      } catch {}
    }

    if (this.deployment.isCloud() && !organizationId) {
      return {
        plan: null,
        connectors: { current: 0, max: null, isOver: false },
        mcpServers: { current: 0, max: null, isOver: false },
        users: { current: 0, max: null, isOver: false },
        isOverAny: false,
      };
    }

    return this.licenseGuard.getUsage(userId, organizationId);
  }

  @Put('key')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Set and activate a license key (ADMIN)' })
  async setLicenseKey(@Req() req: any, @Body() dto: SetLicenseKeyDto) {
    try {
      const license = await this.licenseService.setLicenseKey(dto.licenseKey, req.user.organizationId);
      return { message: 'License activated successfully', license };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to activate license');
    }
  }

  @Post('billing-portal')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary: 'Open the Stripe billing portal for the current subscription (ADMIN)',
  })
  async billingPortal(@Req() req: any, @Body() dto: BillingPortalDto) {
    try {
      return await this.licenseService.createBillingPortalSession(
        req.user.organizationId,
        dto?.returnUrl,
        dto?.flow,
      );
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to open billing portal');
    }
  }

  // ── Invoices by email (Cloud) ──────────────────────────────────────────────

  @Get('invoice-email')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Whether each paid invoice is emailed as a PDF, and to which address (cloud, ADMIN)' })
  async getInvoiceEmail(@Req() req: any) {
    if (!this.deployment.isCloud() || !this.invoiceEmail) {
      throw new NotFoundException('Invoices by email apply to AnythingMCP Cloud only.');
    }
    return this.invoiceEmailCall(() => this.invoiceEmail!.get(req.user.organizationId));
  }

  @Put('invoice-email')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary: 'Switch emailing each paid invoice as a PDF on or off, and set the address (cloud, ADMIN)',
  })
  async setInvoiceEmail(@Req() req: any, @Body() dto: InvoiceEmailDto) {
    if (!this.deployment.isCloud() || !this.invoiceEmail) {
      throw new NotFoundException('Invoices by email apply to AnythingMCP Cloud only.');
    }
    const organizationId: string = req.user.organizationId;
    const view = await this.invoiceEmailCall(() =>
      this.invoiceEmail!.set(organizationId, req.user.sub, { enabled: dto.enabled, to: dto.to }),
    );
    const address = view.recipient.address;
    await this.securityEvents?.log({
      event: SecurityEvents.INVOICE_EMAIL_CHANGED,
      actorType: 'USER',
      organizationId,
      actorUserId: req.user.sub,
      // The domain only: enough to spot a redirect to an outside address.
      metadata: {
        enabled: view.enabled,
        recipientKind: view.recipient.kind,
        recipientDomain: address ? address.slice(address.lastIndexOf('@') + 1) : null,
      },
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
    return view;
  }

  private async invoiceEmailCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof InvoiceEmailError)) throw err;
      switch (err.status) {
        case 400:
          throw new BadRequestException(err.message);
        case 404:
          throw new NotFoundException(err.message);
        case 409:
          throw new ConflictException(err.message);
        case 429:
          throw new HttpException(err.message, HttpStatus.TOO_MANY_REQUESTS);
        default:
          throw new BadGatewayException(err.message);
      }
    }
  }

  @Post('dpa-link')
  @HttpCode(200)
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  // Each call creates a session on the licence site.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary: 'One-hour link to accept the Data Processing Agreement on the licence site (cloud, ADMIN, paid plans)',
  })
  async dpaLink(@Req() req: any, @Body() dto: DpaLinkDto) {
    if (!this.deployment.isCloud()) {
      throw new NotFoundException('The Data Processing Agreement applies to AnythingMCP Cloud only.');
    }
    try {
      return await this.licenseService.createDpaLink(req.user.organizationId, req.user.sub, dto?.locale);
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to open the DPA page.');
    }
  }

  @Post('checkout-link')
  @HttpCode(200)
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  // Each call mints a checkout intent on the licence site: a person clicks
  // this a few times at most, a loop should not be able to do more.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Stripe Checkout link for a cloud plan, optionally as a card trial ending with the free trial (cloud, ADMIN)',
  })
  async checkoutLink(@Req() req: any, @Body() dto: CheckoutLinkDto): Promise<{ url: string; trial: boolean }> {
    // Cloud only. Self-hosted buys its licence on the pricing page and has no
    // workspace billing here; answer as if the route did not exist.
    if (!this.deployment.isCloud()) {
      throw new NotFoundException();
    }
    // RolesGuard already refuses other roles; checked again because a
    // checkout binds the workspace's billing to this person's email.
    if (req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Only workspace administrators can start a subscription');
    }

    // Who pays and for which workspace comes from the session, never from the
    // body (the DTO has no such fields and the global pipe rejects extras).
    const email: string | undefined = req.user?.email;
    const organizationId: string | undefined = req.user?.organizationId;
    if (!email || !organizationId) {
      throw new BadRequestException('No workspace to subscribe');
    }

    const current = await this.licenseService.getCurrentLicense(organizationId);
    // A paying workspace changes plan in the billing portal. A second checkout
    // would add a second subscription beside the first and bill both. A paid
    // licence that was revoked or expired (a customer coming back) does not
    // block a new purchase.
    if (current && current.plan !== 'trial' && current.status === 'active') {
      throw new ConflictException(
        'This workspace already has a subscription. Change your plan in the billing portal.',
      );
    }
    // Nor while Stripe is still retrying a failed payment: the new payment
    // method goes on that subscription, which resumes once it is paid.
    if (!(current && current.plan !== 'trial') && (await this.licenseService.getPaymentFailedLicense(organizationId))) {
      throw new ConflictException(
        'The last payment for this workspace did not go through. Update your payment method to resume your subscription.',
      );
    }

    // A card trial ends when the free trial would have. Asked for after the
    // trial is over, it is a plain purchase: no trialEnd means pay now. An
    // address that had a subscription before gets no trial from the licence
    // site either; asking for one would only hide that it pays today.
    const hadSubscription = dto.trial
      ? await this.cardTrialEligibility.hadSubscription(email).catch(() => null)
      : null;
    const trialEnd = dto.trial && hadSubscription !== true ? cardTrialEnd(current) : null;
    const adMetadata = checkoutAdMetadata(
      await this.productEvents.clickIdForUser(req.user.sub).catch(() => null),
    );
    // Every checkout carries its entry point, so Stripe can count each one.
    const source: CheckoutSource = dto.source ?? DEFAULT_CHECKOUT_SOURCE;

    try {
      const link = await this.licenseService.createCheckoutIntent({
        email,
        plan: `cloud_${dto.plan}`,
        billingPeriod: dto.billingPeriod,
        ...(trialEnd && { trialEnd: trialEnd.toISOString() }),
        returnUrl: `${cloudFrontendOrigin()}/settings/license/activate`,
        organizationId,
        ...(dto.promo && { promoCode: dto.promo.toUpperCase() }),
        ...(adMetadata && { adMetadata }),
        source,
      });
      void this.productEvents.log({
        event: ProductEvents.CHECKOUT_LINK_CREATED,
        userId: req.user.sub,
        organizationId,
        metadata: { via: source, kind: trialEnd ? 'trial' : 'pay' },
      });
      return link;
    } catch (err: any) {
      this.logger.warn(`Checkout link for org ${organizationId} failed: ${err?.message ?? err}`);
      throw new BadGatewayException(
        'The checkout could not be opened right now. Please try again in a moment.',
      );
    }
  }

  @Get('pricing-link-token')
  @UseGuards(JwtOrManagementKeyGuard)
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      "Cloud: the signed-in user's address token for links to the pricing page (#t=), null when EMAIL_LINK_SECRET is unset",
  })
  pricingLinkToken(@Req() req: any): { token: string | null } {
    // With it the pricing page knows who is buying and refuses a second
    // subscription beside a card trial or plan the address already has (the
    // licence site's duplicate guard). The address is the caller's own, and
    // the token only prefills a checkout with it. Self-hosted instances buy
    // their licence on the pricing page as anyone does and get none.
    if (!this.deployment.isCloud()) return { token: null };
    return { token: createEmailLinkToken(req.user?.email) };
  }

  @Get('card-trial-eligibility')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Cloud, ADMIN: whether this address can start a card trial (kind trial), must pay today because it had a subscription (pay), or neither applies (none)',
  })
  async cardTrialEligibilityForUser(
    @Req() req: any,
  ): Promise<{ kind: 'trial' | 'pay' | 'none'; trialEndsAt: string | null }> {
    if (!this.deployment.isCloud()) throw new NotFoundException();
    const result = await this.cardTrialEligibility
      .forAdmin(req.user?.organizationId, req.user?.email)
      .catch(() => ({ kind: 'none' as const }));
    return {
      kind: result.kind,
      trialEndsAt: result.kind === 'trial' ? result.trialEndsAt.toISOString() : null,
    };
  }

  @Get('card-trial-offer')
  @UseGuards(JwtOrManagementKeyGuard)
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Cloud: the card-trial offer after the first successful tool call, for admins of an eligible workspace (null otherwise)',
  })
  async cardTrialOfferForUser(@Req() req: any): Promise<{ offer: CardTrialOfferView | null }> {
    // Null for everyone it does not apply to: self-hosted, members who are
    // not admins (they cannot start a subscription), workspaces that pay or
    // already run a card trial, and trials with under 48 hours left.
    const offer = await this.cardTrialOffer
      .currentOffer(req.user?.organizationId, req.user?.role, req.user?.email)
      .catch(() => null);
    return { offer };
  }

  @Get('plan-fit')
  @UseGuards(JwtOrManagementKeyGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Cloud: what this workspace keeps and loses on Starter and Team (connectors, MCP servers, users, File Search, code mode), with the connectors and servers that would stay active or be paused',
  })
  async planFitForUser(@Req() req: any, @Query('plan') plan?: string): Promise<{ plans: Partial<Record<FitPlan, PlanFit>> }> {
    // Plan limits are a Cloud matter: self-hosted has none of these caps.
    const organizationId: string | undefined = req.user?.organizationId;
    if (!this.planFit || !this.deployment.isCloud() || !organizationId) throw new NotFoundException();
    if (plan !== undefined && !isFitPlan(plan)) throw new BadRequestException('plan must be starter or team');
    if (plan) return { plans: { [plan]: await this.planFit.fit(organizationId, plan) } };
    return { plans: await this.planFit.fitAll(organizationId) };
  }

  @Get('wall')
  @UseGuards(JwtOrManagementKeyGuard)
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({
    summary:
      'Cloud: the ended-trial licence wall for an admin: its variant and the workspace\'s own numbers (null otherwise)',
  })
  async wallForUser(@Req() req: any): Promise<{ wall: LicenseWallView | null }> {
    // Only an admin of a Cloud workspace whose free trial ended sees the wall
    // with the plan picker; everyone else gets null and nothing is recorded.
    const organizationId: string | undefined = req.user?.organizationId;
    if (!this.licenseWall || !this.deployment.isCloud() || !organizationId || req.user?.role !== 'ADMIN') {
      return { wall: null };
    }
    const trial = await this.licenseGuard.getTrialState(organizationId).catch(() => null);
    if (!trial || trial.active) return { wall: null };
    const wall = await this.licenseWall.view(organizationId, req.user?.sub ?? null).catch(() => null);
    return { wall };
  }

  @Post('verify')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Force re-verify license against remote API (ADMIN)' })
  async verifyLicense(@Req() req: any) {
    const result = await this.licenseService.verifyLicense(undefined, req.user.organizationId);
    return result;
  }

  @Post('activate-trial')
  @UseGuards(JwtOrManagementKeyGuard)
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Start a 7-day cloud trial (cloud mode only)' })
  async activateTrial(@Req() req: any) {
    if (!this.deployment.isCloud()) {
      throw new ForbiddenException('Trial activation is only available in cloud mode');
    }

    const user = await this.usersService.findById(req.user.sub);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Idempotent on purpose. The login flow already activates a trial when the
    // email is verified, and the client then calls this endpoint too, so the
    // second call used to answer 400 "a trial already exists" on every single
    // signup: an error shown to a user whose trial is perfectly fine. An org
    // that already holds a licence gets that licence back, and a success.
    const existing = await this.licenseService.getCurrentLicense(req.user.organizationId);
    if (existing) {
      return {
        message: 'Trial already active',
        trialStarted: false,
        licenseKey: existing.licenseKey,
        plan: existing.plan,
        expiresAt: existing.expiresAt?.toISOString() ?? null,
        trialDaysLeft: existing.expiresAt
          ? Math.max(
              0,
              Math.ceil((existing.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
            )
          : 0,
      };
    }

    try {
      const result = await this.licenseService.requestTrialLicense(
        user.email,
        user.name || user.email,
        req.user.organizationId,
      );
      return {
        message: 'Trial activated successfully',
        trialStarted: true,
        ...result,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to activate trial');
    }
  }

  @Post('register-community')
  @UseGuards(JwtOrManagementKeyGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Request a free community license (sent via email)' })
  async registerCommunity(@Req() req: any) {
    const user = await this.usersService.findById(req.user.sub);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    try {
      const result = await this.licenseService.requestCommunityLicense(
        user.email,
        user.name || user.email,
      );
      return { message: result.message, email: user.email };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to register community license');
    }
  }
}

/** Whole days left on a free trial (0 once it is over); undefined for other plans. */
function trialDaysLeftOf(license: { plan: string; expiresAt: Date | null }): number | undefined {
  return license.plan === 'trial' && license.expiresAt
    ? Math.max(0, Math.ceil((new Date(license.expiresAt).getTime() - Date.now()) / 86400000))
    : undefined;
}

/**
 * Whether a request presents the licence site's service token
 * (LICENSE_SERVICE_TOKEN, the secret this server also presents to the site).
 * False when the server has no token configured.
 */
export function serviceTokenMatches(presented: unknown): boolean {
  const expected = process.env.LICENSE_SERVICE_TOKEN;
  if (!expected || typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
