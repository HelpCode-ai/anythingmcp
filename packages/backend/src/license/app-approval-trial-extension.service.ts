import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { LicenseGuardService } from './license-guard.service';
import { LicenseService } from './license.service';
import { RetentionLicenceClient } from './retention-licence.client';
import { TRIAL_EXTENSION_LINK_DAYS } from './trial-extension-token';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A trial with less than this left counts as "no time to try the connector". */
export const TRIAL_TOO_SHORT_MS = DAY_MS;

export interface TrialDaysAdded {
  /** Whole days between the old end (or now, when it had passed) and the new one. */
  daysAdded: number;
  until: Date;
}

/**
 * Time to try a connector whose provider approved the app too late.
 *
 * A provider can take days to approve a user's own app (Etsy), and the free
 * trial runs meanwhile: of 88 approval emails, 21 arrived after the trial had
 * ended and 13 more within a day of its end. Those users could finish the
 * sign-in but not use the connector.
 *
 * This asks for the trial extension that already exists, the one behind the
 * link in the "your trial has ended" email (trial-extension.controller.ts):
 * `RetentionLicenceClient.extendTrial`, a call to the licence site, which
 * decides and grants. No licence rule lives here. What the site gives is its
 * rule: 7 days from the moment it is asked, once per trial licence, while the
 * trial runs or ended under 7 days ago. So an extension taken here is the
 * workspace's one extension: the link in the trial-ended email then answers
 * "already extended".
 *
 * Cloud only (self-hosted has no workspace trial and never calls the site),
 * only for a workspace on the free trial (a paid plan and a card trial are not
 * plan 'trial'), and only when the trial has ended or ends within a day.
 * Every refusal and every failure answers null: the caller sends its email
 * without the sentence about added days.
 */
@Injectable()
export class AppApprovalTrialExtensionService {
  private readonly logger = new Logger(AppApprovalTrialExtensionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly licenseService: LicenseService,
    private readonly client: RetentionLicenceClient,
    private readonly productEvents: ProductEventService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async extendIfTooLate(
    organizationId: string,
    context: { connectorId: string; adapterSlug: string },
    now: Date = new Date(),
  ): Promise<TrialDaysAdded | null> {
    if (!this.deployment.isCloud()) return null;

    const trial = await this.licenseGuard.getTrialState(organizationId, now);
    // Null: a paid plan, a card trial, or no licence at all.
    if (!trial) return null;
    const end = trial.endsAt.getTime();
    if (trial.active && end - now.getTime() > TRIAL_TOO_SHORT_MS) return null;
    // The site refuses past its window; no need to ask.
    if (now.getTime() - end >= TRIAL_EXTENSION_LINK_DAYS * DAY_MS) return null;

    // Once per workspace, known here without asking: the site refuses a
    // second one for the same licence anyway.
    const earlier = await this.prisma.productEvent.findFirst({
      where: { organizationId, event: ProductEvents.TRIAL_EXTENDED },
      select: { id: true },
    });
    if (earlier) return null;

    const licence = await this.prisma.license.findFirst({
      where: { organizationId, plan: 'trial' },
      orderBy: { createdAt: 'desc' },
      select: { licenseKey: true },
    });
    if (!licence) return null;

    const answer = await this.client.extendTrial(licence.licenseKey);
    if (!answer) return null;
    if (!answer.ok) {
      this.logger.log(`Trial of workspace ${organizationId} not extended for an approved app: ${answer.reason}`);
      return null;
    }

    // The site set the trial active again with its new end: read it back so
    // the licence guard lets the workspace's calls through at once.
    await this.licenseService.verifyLicense(licence.licenseKey, organizationId).catch((err) =>
      this.logger.warn(`Extended trial of workspace ${organizationId} not re-verified yet: ${err?.message ?? err}`),
    );
    const until = answer.expiresAt;
    await this.securityEvents.log({
      event: SecurityEvents.TRIAL_EXTENDED,
      actorType: 'SYSTEM',
      organizationId,
      metadata: { until: until.toISOString(), via: 'app_approved', connectorId: context.connectorId },
    });
    await this.productEvents.log({
      event: ProductEvents.TRIAL_EXTENDED,
      organizationId,
      metadata: { via: 'app_approved', connectorId: context.connectorId, adapterSlug: context.adapterSlug },
    });
    this.logger.log(`Trial of workspace ${organizationId} extended until ${until.toISOString()} (app approved late)`);

    const daysAdded = Math.round((until.getTime() - Math.max(end, now.getTime())) / DAY_MS);
    // An end the site did not move forward is not "days added".
    return daysAdded >= 1 ? { daysAdded, until } : null;
  }
}
