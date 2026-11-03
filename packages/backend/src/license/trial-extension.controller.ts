import { Controller, Get, Logger, NotFoundException, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { escapeHtml, renderAuthPage } from '../auth/auth-page';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { LicenseService } from './license.service';
import { RetentionLicenceClient } from './retention-licence.client';
import { readTrialExtensionToken, trialExtensionSecret } from './trial-extension-token';
import { cloudFrontendOrigin } from './license-checkout';

/**
 * One-click 7-day trial extension, from the link in the Cloud "your trial has
 * ended" email (business workspaces). Cloud only: 404 on self-hosted.
 *
 * - GET shows a button. Mail scanners and link previews fetch every URL in an
 *   email, and a GET that extended the trial would spend the one extension
 *   when the email arrived instead of when the reader asked for it (as with
 *   the unsubscribe link, unsubscribe.controller.ts).
 * - POST, which the button submits, asks the licence site to extend the
 *   workspace's trial licence, re-verifies it here so the workspace is
 *   active again at once, writes the audit log and the `trial_extended`
 *   product event, and redirects to the dashboard with the outcome
 *   (`?trial_extended=ok&until=<ISO date>`, or the refusal's reason), which
 *   the dashboard shows as a banner.
 *
 * The token (trial-extension-token.ts) names the workspace and expires 7 days
 * after the trial ended; no sign-in is needed, like the unsubscribe link.
 */
export type TrialExtensionOutcome =
  | 'ok'
  | 'invalid'
  | 'expired'
  | 'not_found'
  | 'not_trial'
  | 'already_extended'
  | 'too_late'
  | 'revoked'
  | 'invalid_key'
  | 'unavailable';

@ApiExcludeController()
@Controller('api/license/extend')
export class TrialExtensionController {
  private readonly logger = new Logger(TrialExtensionController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly licenseService: LicenseService,
    private readonly client: RetentionLicenceClient,
    private readonly productEvents: ProductEventService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@Query('token') token: string, @Res() res: Response) {
    if (!this.deployment.isCloud()) throw new NotFoundException();
    const check = this.check(token);
    if (!check.ok) return this.redirect(res, check.reason);
    const action = `/api/license/extend?token=${encodeURIComponent(token)}`;
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      renderAuthPage({
        title: 'Extend your trial — AnythingMCP',
        trust: { cloud: true },
        card: `
    <h1>Extend your trial by 7 days?</h1>
    <p class="sub">Your workspace, its connectors and settings come back as they were, for 7 more days. This works once.</p>
    <form method="POST" action="${escapeHtml(action)}">
      <button type="submit">Extend my trial</button>
    </form>`,
      }),
    );
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async extend(@Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    if (!this.deployment.isCloud()) throw new NotFoundException();
    const check = this.check(token);
    if (!check.ok) return this.redirect(res, check.reason);
    const { organizationId } = check;

    const trial = await this.prisma.license.findFirst({
      where: { organizationId, plan: 'trial' },
      orderBy: { createdAt: 'desc' },
      select: { licenseKey: true },
    });
    if (!trial) return this.redirect(res, 'not_found');

    const answer = await this.client.extendTrial(trial.licenseKey);
    if (!answer) return this.redirect(res, 'unavailable');
    if (!answer.ok) {
      this.logger.log(`Trial extension for workspace ${organizationId} refused: ${answer.reason}`);
      return this.redirect(res, answer.reason);
    }

    // The site set the trial active again with its new end. Read it back now
    // (refreshLicense only re-checks paid licences), so the licence guard lets
    // the workspace's calls through at once.
    await this.licenseService.verifyLicense(trial.licenseKey, organizationId).catch((err) =>
      this.logger.warn(`Extended trial of workspace ${organizationId} not re-verified yet: ${err?.message ?? err}`),
    );
    const until = answer.expiresAt.toISOString();
    await this.securityEvents.log({
      event: SecurityEvents.TRIAL_EXTENDED,
      actorType: 'ANONYMOUS',
      organizationId,
      metadata: { until, via: 'email_link' },
      ip: req.ip ?? null,
      userAgent: req.get?.('user-agent') ?? null,
    });
    await this.productEvents.log({
      event: ProductEvents.TRIAL_EXTENDED,
      organizationId,
      metadata: { via: 'email' },
    });
    this.logger.log(`Trial of workspace ${organizationId} extended until ${until}`);
    return this.redirect(res, 'ok', until);
  }

  private check(token: unknown) {
    const secret = trialExtensionSecret();
    if (!secret) return { ok: false as const, reason: 'unavailable' as const };
    return readTrialExtensionToken(token, secret);
  }

  private redirect(res: Response, outcome: TrialExtensionOutcome, until?: string) {
    const params = new URLSearchParams({ trial_extended: outcome, ...(until ? { until } : {}) });
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, `${cloudFrontendOrigin()}/?${params.toString()}`);
  }
}
