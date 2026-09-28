import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { SiteSettingsService } from '../../settings/site-settings.service';
import { LicenseService, LicenseInfo } from '../../license/license.service';

/** Active users a Community instance includes. */
export const COMMUNITY_SEAT_LIMIT = 3;
/** Length of the Business evaluation an admin can start once per instance. */
export const BUSINESS_TRIAL_DAYS = 30;
/**
 * How long an instance that already used Business capabilities before this
 * release keeps them, counted from its first start on this release.
 */
export const TRANSITION_DAYS = 60;

const PAID_PLANS = new Set(['starter', 'team', 'business', 'enterprise']);
const TRIAL_KEY = 'business_trial_ends_at';
const TRANSITION_KEY = 'business_transition_until';
const DAY_MS = 24 * 60 * 60 * 1000;

export type Edition = 'cloud' | 'community' | 'business';
export type BusinessSource = 'license' | 'trial' | 'transition' | null;

export interface EditionState {
  edition: Edition;
  /** Whether Business capabilities (SSO, SCIM, more users) are available. */
  business: boolean;
  source: BusinessSource;
  /** Plan of the activated licence key, if any. */
  plan: string | null;
  /** Active users this instance may have; null = no limit. */
  seatLimit: number | null;
  seatsUsed: number;
  communitySeatLimit: number;
  trialEndsAt: string | null;
  trialAvailable: boolean;
  trialDays: number;
  transitionUntil: string | null;
}

/** Error code the frontend reads to offer the Business options. */
export const EDITION_REQUIRED = 'edition_required';
export const SEAT_LIMIT = 'seat_limit';

/**
 * Which edition a self-hosted instance runs, and what that allows.
 *
 * Community is the default. Business comes from an activated licence key,
 * from the one-time evaluation, or from the transition period of an instance
 * that already relied on Business capabilities when it was upgraded.
 *
 * The rules never take away something that already works: existing users stay
 * active above the limit, existing single sign-on identities keep signing in,
 * an enforced SSO policy stays enforced and SCIM keeps deactivating leavers.
 * What needs Business is setting those capabilities up and adding people.
 *
 * AnythingMCP Cloud has its own plans and is never limited here.
 */
@Injectable()
export class EditionService implements OnModuleInit {
  private readonly logger = new Logger(EditionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
    private readonly siteSettings: SiteSettingsService,
    private readonly licenses: LicenseService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.deployment.isCloud()) return;
    try {
      await this.recordTransition();
    } catch (err: any) {
      this.logger.warn(`Could not evaluate the edition transition: ${err.message}`);
    }
  }

  /**
   * Runs once per instance. An instance that already has an identity provider
   * or more users than Community includes keeps Business capabilities for
   * TRANSITION_DAYS, so upgrading never changes what it can do overnight.
   */
  async recordTransition(now = new Date()): Promise<void> {
    if ((await this.siteSettings.get(TRANSITION_KEY)) !== null) return;

    const [providers, seats] = await Promise.all([
      this.prisma.identityProvider.count(),
      this.countSeats(),
    ]);
    if (providers > 0 || seats > COMMUNITY_SEAT_LIMIT) {
      const until = new Date(now.getTime() + TRANSITION_DAYS * DAY_MS);
      await this.siteSettings.set(TRANSITION_KEY, until.toISOString());
      this.logger.log(`Business capabilities kept until ${until.toISOString()}.`);
    } else {
      await this.siteSettings.set(TRANSITION_KEY, 'none');
    }
  }

  async getState(now = new Date()): Promise<EditionState> {
    const seatsUsed = await this.countSeats();

    if (this.deployment.isCloud()) {
      return {
        edition: 'cloud',
        business: true,
        source: null,
        plan: null,
        seatLimit: null,
        seatsUsed,
        communitySeatLimit: COMMUNITY_SEAT_LIMIT,
        trialEndsAt: null,
        trialAvailable: false,
        trialDays: BUSINESS_TRIAL_DAYS,
        transitionUntil: null,
      };
    }

    const [license, trialRaw, transitionRaw] = await Promise.all([
      this.licenses.getCurrentLicense(),
      this.siteSettings.get(TRIAL_KEY),
      this.siteSettings.get(TRANSITION_KEY),
    ]);

    const paid = this.isPaid(license, now);
    const trialEnds = parseDate(trialRaw);
    const transitionUntil = parseDate(transitionRaw);
    const trialActive = !!trialEnds && trialEnds > now;
    const transitionActive = !!transitionUntil && transitionUntil > now;

    const source: BusinessSource = paid
      ? 'license'
      : trialActive
        ? 'trial'
        : transitionActive
          ? 'transition'
          : null;

    let seatLimit: number | null = COMMUNITY_SEAT_LIMIT;
    if (source === 'license') {
      const max = (license?.features as any)?.maxUsers;
      seatLimit = typeof max === 'number' ? Math.max(COMMUNITY_SEAT_LIMIT, max) : null;
    } else if (source) {
      seatLimit = null;
    }

    return {
      edition: source ? 'business' : 'community',
      business: source !== null,
      source,
      plan: license?.plan ?? null,
      seatLimit,
      seatsUsed,
      communitySeatLimit: COMMUNITY_SEAT_LIMIT,
      trialEndsAt: trialEnds?.toISOString() ?? null,
      trialAvailable: trialRaw === null && !paid,
      trialDays: BUSINESS_TRIAL_DAYS,
      transitionUntil: transitionActive ? transitionUntil!.toISOString() : null,
    };
  }

  async hasBusiness(): Promise<boolean> {
    if (this.deployment.isCloud()) return true;
    return (await this.getState()).business;
  }

  /** Throws a 403 the frontend recognises when Business is not available. */
  async assertBusiness(capability: string): Promise<void> {
    if (await this.hasBusiness()) return;
    throw new ForbiddenException({
      statusCode: 403,
      code: EDITION_REQUIRED,
      message: `${capability} is available with AnythingMCP Business. Start a trial or activate a license key under Settings → License.`,
    });
  }

  /**
   * Whether one more active user fits. A user who is already active in some
   * workspace of this instance does not take another seat.
   */
  async seatAvailable(userId?: string): Promise<{ ok: boolean; limit: number | null }> {
    if (this.deployment.isCloud()) return { ok: true, limit: null };
    if (userId && (await this.isActiveSomewhere(userId))) return { ok: true, limit: null };
    const state = await this.getState();
    if (state.seatLimit === null) return { ok: true, limit: null };
    return { ok: state.seatsUsed < state.seatLimit, limit: state.seatLimit };
  }

  async assertSeatAvailable(userId?: string): Promise<void> {
    const { ok, limit } = await this.seatAvailable(userId);
    if (ok) return;
    throw new ForbiddenException({
      statusCode: 403,
      code: SEAT_LIMIT,
      message: seatLimitMessage(limit!),
    });
  }

  async startTrial(now = new Date()): Promise<EditionState> {
    if (this.deployment.isCloud()) throw new NotFoundException('Not found');
    if ((await this.siteSettings.get(TRIAL_KEY)) !== null) {
      throw new ConflictException('The Business trial has already been used on this instance.');
    }
    const ends = new Date(now.getTime() + BUSINESS_TRIAL_DAYS * DAY_MS);
    await this.siteSettings.set(TRIAL_KEY, ends.toISOString());
    this.logger.log(`Business trial started, ends ${ends.toISOString()}.`);
    return this.getState(now);
  }

  private isPaid(license: LicenseInfo | null, now: Date): boolean {
    if (!license || !PAID_PLANS.has(license.plan)) return false;
    if (license.status !== 'active') return false;
    return !license.expiresAt || new Date(license.expiresAt) > now;
  }

  /** Users with at least one active membership, across the instance. */
  private countSeats(): Promise<number> {
    return this.prisma.user.count({
      where: { memberships: { some: { deactivatedAt: null } } },
    });
  }

  private async isActiveSomewhere(userId: string): Promise<boolean> {
    const n = await this.prisma.organizationMember.count({
      where: { userId, deactivatedAt: null },
    });
    return n > 0;
  }
}

export function seatLimitMessage(limit: number): string {
  return `This instance has reached its limit of ${limit} active users. An administrator can add more with AnythingMCP Business under Settings → License.`;
}

function parseDate(value: string | null): Date | null {
  if (!value || value === 'none') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
