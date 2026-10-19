import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { KgStaticService } from './kg-static.service';

export const LEARNING_MODES = ['inherit', 'on', 'off'] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];

/** Workspace switch that members set to `inherit` follow. */
export const LEARNING_DEFAULT_FLAG = 'kg_capture_intent';

/** Most members one bulk change may touch. */
export const LEARNING_BULK_MAX = 500;

export interface LearningActionContext {
  actorUserId: string;
  ip?: string;
  userAgent?: string;
}

export interface MemberLearning {
  /** The workspace switch (`Capture user intent`). */
  workspaceDefault: boolean;
  mode: LearningMode;
  optOut: boolean;
  /** Whether this member's requests are used for learning right now. */
  effective: boolean;
}

/**
 * The member's own opt-out wins; otherwise an admin's `on`/`off`, otherwise
 * the workspace switch.
 */
export function effectiveLearning(
  mode: string,
  optOut: boolean,
  workspaceDefault: boolean,
): boolean {
  if (optOut) return false;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return workspaceDefault;
}

/**
 * Whether a caller may contribute to skill learning in a workspace: an active
 * member whose effective setting is on. No user, a non-member (e.g. a
 * `client:<id>` token) or a deactivated member never contributes.
 */
export async function memberContributes(
  prisma: PrismaService,
  staticSvc: KgStaticService,
  organizationId: string,
  userId?: string | null,
): Promise<boolean> {
  if (!organizationId || !userId) return false;
  const [workspaceDefault, member] = await Promise.all([
    staticSvc.getFlag(organizationId, LEARNING_DEFAULT_FLAG, false),
    prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { learningMode: true, learningOptOut: true, deactivatedAt: true },
    }),
  ]);
  if (!member || member.deactivatedAt) return false;
  return effectiveLearning(member.learningMode, member.learningOptOut, workspaceDefault);
}

/**
 * Who may contribute to skill learning. A contributing caller's tools carry
 * the optional `_intent` parameter and their intents are stored; for anyone
 * else the parameter is not offered and nothing is captured.
 *
 * Settings live on the membership, so the same person can differ between
 * workspaces (Cloud) and a caller without a member identity (static instance
 * credentials, client-credentials tokens) never contributes.
 */
@Injectable()
export class KgLearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staticSvc: KgStaticService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  workspaceDefault(organizationId: string): Promise<boolean> {
    return this.staticSvc.getFlag(organizationId, LEARNING_DEFAULT_FLAG, false);
  }

  /** Whether this caller's tool calls may capture intent. Fails closed. */
  canContribute(organizationId: string, userId?: string | null): Promise<boolean> {
    return memberContributes(this.prisma, this.staticSvc, organizationId, userId);
  }

  async getForMember(organizationId: string, userId: string): Promise<MemberLearning> {
    const [workspaceDefault, member] = await Promise.all([
      this.workspaceDefault(organizationId),
      this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { learningMode: true, learningOptOut: true },
      }),
    ]);
    if (!member) throw new NotFoundException('Member not found.');
    const mode = toMode(member.learningMode);
    return {
      workspaceDefault,
      mode,
      optOut: member.learningOptOut,
      effective: effectiveLearning(mode, member.learningOptOut, workspaceDefault),
    };
  }

  /**
   * Admin: set the mode of one or more members of this workspace. Ids that
   * are not members here are ignored (reported as `notFound`), never touched.
   * `clearIntents` also erases the intents already captured from members
   * whose learning ends up off.
   */
  async setMode(
    organizationId: string,
    userIds: string[],
    mode: LearningMode,
    ctx: LearningActionContext,
    opts?: { clearIntents?: boolean },
  ): Promise<{ updated: number; notFound: string[]; intentsCleared: number }> {
    const ids = [...new Set(userIds)].slice(0, LEARNING_BULK_MAX);
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: ids } },
      select: { userId: true, learningMode: true, learningOptOut: true },
    });
    const found = new Set(members.map((m) => m.userId));
    const notFound = ids.filter((id) => !found.has(id));
    const changed = members.filter((m) => m.learningMode !== mode);

    if (changed.length > 0) {
      await this.prisma.organizationMember.updateMany({
        where: { organizationId, userId: { in: changed.map((m) => m.userId) } },
        data: { learningMode: mode },
      });
    }
    for (const m of changed) {
      await this.securityEvents.log({
        event: SecurityEvents.LEARNING_CHANGED,
        actorType: 'USER',
        organizationId,
        actorUserId: ctx.actorUserId,
        targetUserId: m.userId,
        metadata: { from: m.learningMode, to: mode, via: 'admin' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    let intentsCleared = 0;
    if (opts?.clearIntents) {
      const workspaceDefault = await this.workspaceDefault(organizationId);
      const off = members
        .filter((m) => !effectiveLearning(mode, m.learningOptOut, workspaceDefault))
        .map((m) => m.userId);
      intentsCleared = await this.clearIntents(organizationId, off);
    }
    return { updated: changed.length, notFound, intentsCleared };
  }

  /** Member: opt out of (or back into) learning in this workspace. */
  async setOptOut(
    organizationId: string,
    userId: string,
    optOut: boolean,
    ctx: LearningActionContext,
    opts?: { clearIntents?: boolean },
  ): Promise<MemberLearning & { intentsCleared: number }> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { learningOptOut: true },
    });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.learningOptOut !== optOut) {
      await this.prisma.organizationMember.update({
        where: { userId_organizationId: { userId, organizationId } },
        data: { learningOptOut: optOut },
      });
      await this.securityEvents.log({
        event: SecurityEvents.LEARNING_CHANGED,
        actorType: 'USER',
        organizationId,
        actorUserId: ctx.actorUserId,
        targetUserId: userId,
        metadata: { optOut, via: 'self' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    const intentsCleared =
      optOut && opts?.clearIntents ? await this.clearIntents(organizationId, [userId]) : 0;
    return { ...(await this.getForMember(organizationId, userId)), intentsCleared };
  }

  /** Erase captured intents of these members in this workspace only. */
  private async clearIntents(organizationId: string, userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const res = await this.prisma.toolInvocation.updateMany({
      where: { organizationId, userId: { in: userIds }, intent: { not: null } },
      data: { intent: null },
    });
    return res.count;
  }
}

function toMode(value: string): LearningMode {
  return (LEARNING_MODES as readonly string[]).includes(value) ? (value as LearningMode) : 'inherit';
}
