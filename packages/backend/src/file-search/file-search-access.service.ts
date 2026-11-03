import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { quotaForPlan } from './file-search-quotas';
import type { FileSearchQuota } from './file-search.types';

/**
 * Whether a workspace may use File Search, and with which limits (#1386).
 *
 * Reads the licence rows itself instead of going through LicenseService, so
 * the files-worker process can use it without starting the licence
 * re-verification timers. The rules mirror LicenseService.getCurrentLicense
 * and EditionService:
 *   - Cloud: the workspace's own active licence (trial included, within its
 *     dates); no licence → locked.
 *   - Self-hosted: a live paid key (starter, team, business, enterprise) of
 *     the workspace or the instance; else the 30-day evaluation; else locked.
 *     Community never gets File Search after the evaluation. The evaluation
 *     opens File Search only with a registered licence key of any plan (the
 *     free Community key too); evaluations started before that rule keep it
 *     until they end.
 */

export const FILE_SEARCH_LOCKED = 'file_search_locked';
/**
 * Site setting EditionService.startTrial writes on every trial it starts from
 * this release on: such a trial opens File Search only while a licence key is
 * registered. Trials started earlier have no marker and keep File Search.
 */
export const FILE_SEARCH_TRIAL_NEEDS_KEY = 'file_search_trial_needs_key';
/** Why a self-hosted Community instance waits for a licence key, if it does. */
export type KeyRequired = 'to_start' | 'during_trial' | null;
/** Self-hosted is sold as Community and Enterprise (on request). */
const ENTERPRISE_CONTACT_URL = 'https://anythingmcp.com/contact?plan=enterprise';
const PAID = new Set(['starter', 'team', 'business', 'enterprise']);
const TRIAL_KEY = 'business_trial_ends_at';
const CACHE_MS = 30_000;

export type FileSearchAccess =
  | { allowed: true; plan: string; quota: FileSearchQuota; cloud: boolean; trialEndsAt: string | null }
  | {
      allowed: false;
      reason: 'no_licence' | 'expired' | 'community' | 'plan_without_feature';
      cloud: boolean;
      trialAvailable: boolean;
      /** Self-hosted: File Search waits for a registered licence key. */
      keyRequired: KeyRequired;
      message: string;
    };

interface LicenceRow {
  plan: string;
  status: string;
  expiresAt: Date | null;
  features: unknown;
}

@Injectable()
export class FileSearchAccessService {
  private readonly cache = new Map<string, { at: number; value: FileSearchAccess }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

  invalidate(organizationId?: string): void {
    if (organizationId) this.cache.delete(organizationId);
    else this.cache.clear();
  }

  async resolve(organizationId: string, now = new Date()): Promise<FileSearchAccess> {
    const hit = this.cache.get(organizationId);
    if (hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
    const value = await this.compute(organizationId, now);
    this.cache.set(organizationId, { at: now.getTime(), value });
    return value;
  }

  /** Throws the 403 the frontend recognises (code `file_search_locked`). */
  async assertAllowed(organizationId: string): Promise<Extract<FileSearchAccess, { allowed: true }>> {
    const a = await this.resolve(organizationId);
    if (a.allowed) return a;
    throw new ForbiddenException({
      statusCode: 403,
      code: FILE_SEARCH_LOCKED,
      reason: a.reason,
      trialAvailable: a.trialAvailable,
      keyRequired: a.keyRequired,
      message: a.message,
    });
  }

  private async compute(organizationId: string, now: Date): Promise<FileSearchAccess> {
    const cloud = this.deployment.isCloud();
    if (cloud) {
      const lic = await this.prisma.license.findFirst({
        where: { organizationId, status: 'active' },
        orderBy: { createdAt: 'desc' },
        select: { plan: true, status: true, expiresAt: true, features: true },
      });
      if (!lic) {
        return { allowed: false, reason: 'no_licence', cloud, trialAvailable: false, keyRequired: null, message: 'File Search needs an active plan. Ask a workspace administrator to choose one.' };
      }
      if (lic.expiresAt && lic.expiresAt < now) {
        return {
          allowed: false,
          reason: 'expired',
          cloud,
          trialAvailable: false,
          keyRequired: null,
          message: lic.plan === 'trial' ? 'The free trial has ended. File Search continues with a paid plan.' : 'The licence has expired. Renew it to continue using File Search.',
        };
      }
      const quota = quotaForPlan(lic.plan, { cloud, overrides: (lic.features as any)?.fileSearch });
      if (!quota) {
        return { allowed: false, reason: 'plan_without_feature', cloud, trialAvailable: false, keyRequired: null, message: `The ${lic.plan} plan does not include File Search.` };
      }
      return { allowed: true, plan: lic.plan, quota, cloud, trialEndsAt: lic.plan === 'trial' && lic.expiresAt ? lic.expiresAt.toISOString() : null };
    }

    const lic = await this.selfHostedLicence(organizationId);
    if (lic && PAID.has(lic.plan) && lic.status === 'active' && (!lic.expiresAt || lic.expiresAt > now)) {
      const quota = quotaForPlan(lic.plan, { cloud, overrides: (lic.features as any)?.fileSearch })!;
      return { allowed: true, plan: lic.plan, quota, cloud, trialEndsAt: null };
    }
    const [trialRaw, needsKeyRaw] = await Promise.all([this.setting(TRIAL_KEY), this.setting(FILE_SEARCH_TRIAL_NEEDS_KEY)]);
    // Any registered key counts, the free Community key included.
    const keyRegistered = !!lic;
    const trialEnds = trialRaw ? new Date(trialRaw) : null;
    if (trialEnds && !Number.isNaN(trialEnds.getTime()) && trialEnds > now) {
      if (keyRegistered || needsKeyRaw !== 'true') {
        return { allowed: true, plan: 'trial', quota: quotaForPlan('trial', { cloud })!, cloud, trialEndsAt: trialEnds.toISOString() };
      }
      return {
        allowed: false,
        reason: 'community',
        cloud,
        trialAvailable: false,
        keyRequired: 'during_trial',
        message: 'Register a free Community key under Settings → License to use File Search during the trial.',
      };
    }
    const unused = trialRaw === null;
    if (unused && !keyRegistered) {
      return {
        allowed: false,
        reason: 'community',
        cloud,
        trialAvailable: false,
        keyRequired: 'to_start',
        message: 'Register a free Community key under Settings → License to start the 30-day File Search trial.',
      };
    }
    return {
      allowed: false,
      reason: lic && lic.expiresAt && lic.expiresAt <= now ? 'expired' : 'community',
      cloud,
      trialAvailable: unused,
      keyRequired: null,
      message: unused
        ? 'Start the free 30-day trial or activate a licence to use File Search.'
        : `The 30-day trial has ended. File Search continues with AnythingMCP Enterprise (${ENTERPRISE_CONTACT_URL}); your index is kept for 30 days.`,
    };
  }

  private async setting(key: string): Promise<string | null> {
    return (await this.prisma.siteSettings.findUnique({ where: { key } }))?.value ?? null;
  }

  private async selfHostedLicence(organizationId: string): Promise<LicenceRow | null> {
    const select = { plan: true, status: true, expiresAt: true, features: true } as const;
    const own = await this.prisma.license.findFirst({ where: { organizationId, status: 'active' }, orderBy: { createdAt: 'desc' }, select });
    if (own) return own;
    const key = await this.setting('license_key');
    if (key) {
      const byKey = await this.prisma.license.findUnique({ where: { licenseKey: key }, select });
      if (byKey) return byKey;
    }
    return this.prisma.license.findFirst({ where: { status: 'active', organizationId: null }, orderBy: { createdAt: 'desc' }, select });
  }
}
