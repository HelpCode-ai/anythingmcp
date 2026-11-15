import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { LicenseService, LicenseInfo } from '../../license/license.service';
import { PlanLimitException } from '../../license/plan-caps';
import { EDITION_REQUIRED, EditionService } from '../licensing/edition.service';
import { LEARNING_OPEN_STATUSES, LearningAllowance, learningAllowance } from './learning-quotas';

/** How long a workspace's allowance is cached (it is read on MCP requests). */
const ALLOWANCE_CACHE_MS = 60_000;

export interface LearningUsage extends LearningAllowance {
  /** Projects waiting for consent or active. */
  used: number;
}

/**
 * What a workspace's plan includes for learning projects, on Cloud and
 * self-hosted. A downgrade never removes anything: published skills stay, and
 * the projects above the new number are paused by the learning service.
 */
@Injectable()
export class LearningAccessService {
  private readonly cache = new Map<string, { value: LearningAllowance; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly licenses: LicenseService,
    private readonly edition: EditionService,
  ) {}

  async allowance(organizationId: string, now = new Date()): Promise<LearningAllowance> {
    if (!organizationId) return { max: 0, full: false, plan: 'none' };
    const hit = this.cache.get(organizationId);
    if (hit && now.getTime() - hit.at < ALLOWANCE_CACHE_MS) return hit.value;

    const cloud = this.deployment.isCloud();
    const license = await this.licenses.getCurrentLicense(organizationId);
    const active = isActive(license, now);
    // Only a self-hosted instance without an Enterprise key can be evaluating.
    const evaluation =
      !cloud && !(active && license?.plan === 'enterprise')
        ? (await this.edition.getState(now)).source === 'trial'
        : false;
    const value = learningAllowance({
      plan: license?.plan,
      active,
      cloud,
      evaluation,
      override: (license?.features as Record<string, unknown> | null | undefined)?.maxLearningProjects,
    });
    this.cache.set(organizationId, { value, at: now.getTime() });
    return value;
  }

  async usage(organizationId: string): Promise<LearningUsage> {
    const [allowance, used] = await Promise.all([
      this.allowance(organizationId),
      this.prisma.learningProject.count({
        where: { organizationId, status: { in: [...LEARNING_OPEN_STATUSES] } },
      }),
    ]);
    return { ...allowance, used };
  }

  /**
   * Refuses a new (or resumed) project the plan does not include: the 403 the
   * dashboard turns into the plan offer when the plan has none, the plan-limit
   * 403 when the number is reached.
   */
  async assertCanOpen(organizationId: string): Promise<void> {
    const { max, used } = await this.usage(organizationId);
    if (max === null || used < max) return;
    if (max === 0) {
      throw new ForbiddenException({
        statusCode: 403,
        code: EDITION_REQUIRED,
        message: this.deployment.isCloud()
          ? 'Learning projects are available with the Team and Enterprise plans.'
          : 'Learning projects are available with AnythingMCP Enterprise.',
      });
    }
    throw new PlanLimitException(
      'learningProjects',
      max,
      used,
      `Your plan includes ${max} learning project${max === 1 ? '' : 's'} at a time. End or pause one first, or upgrade the plan.`,
    );
  }

  /** Forget a cached answer, e.g. after the licence changed. */
  forget(organizationId: string): void {
    this.cache.delete(organizationId);
  }
}

function isActive(license: LicenseInfo | null, now: Date): boolean {
  if (!license || license.status !== 'active') return false;
  return !license.expiresAt || new Date(license.expiresAt) > now;
}
