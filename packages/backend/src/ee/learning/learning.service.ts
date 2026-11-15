import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../../audit/security-event.service';
import { KgSkillService, skillKey } from '../../knowledge-graph/kg-skill.service';
import { looksLikeInjection, looksLikeSecret } from '../../memory/memory.service';
import { LearningAccessService } from './learning-access.service';
import { LEARNING_OPEN_STATUSES } from './learning-quotas';
import { LESSON_KINDS, LessonDetail, LessonKind, lessonDetail, renderLearnedSkill } from './learning-render';

export const PROJECT_STATUSES = ['draft', 'active', 'paused', 'ended'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PUBLISH_MODES = ['manual', 'confirmed'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** Limits of one project. A topic past its size asks for a narrower topic. */
export const LEARNING_LIMITS = {
  topics: 40,
  lessonsPerTopic: 300,
  lessons: 2000,
  lessonsPerHour: 60,
  title: 80,
  text: 2000,
  detail: 1000,
  whenToUse: 300,
  notice: 4000,
  tags: 10,
  review: 10,
  decisions: 20,
} as const;

/** How long the answer "has this caller an active project here" is kept. */
const ACTIVE_CACHE_MS = 60_000;
const ACTIVE_CACHE_MAX = 5000;

export interface LearningActionContext {
  actorUserId: string;
  ip?: string;
  userAgent?: string;
}

/** What the MCP endpoint needs to offer the learning tools to a caller. */
export interface ActiveLearning {
  projectId: string;
  organizationId: string;
  userId: string;
  mcpServerId: string;
  name: string;
  consentAt: Date;
  /** The Enterprise parts are included in the workspace's plan. */
  full: boolean;
  topics: Array<{ id: string; title: string; whenToUse: string }>;
}

export interface RecordLessonInput {
  topic: string;
  kind: string;
  text: string;
  before?: string;
  after?: string;
  reason?: string;
  tool?: string;
  whenToUse?: string;
  /** Id of an earlier lesson of this project that this one corrects. */
  replaces?: string;
  source?: 'model' | 'diff' | 'interview' | 'manual';
}

export interface LessonDecision {
  id: string;
  verdict: 'confirm' | 'reject' | 'correct';
  /** The corrected lesson, for `correct`. */
  text?: string;
  reason?: string;
}

type ProjectRow = {
  id: string;
  organizationId: string;
  name: string;
  userId: string | null;
  mcpServerId: string | null;
  folderId: string | null;
  status: string;
  publishMode: string;
  tags: unknown;
  settings: unknown;
  startsAt: Date | null;
  endsAt: Date | null;
  consentAt: Date | null;
};

type TopicRow = {
  id: string;
  projectId: string;
  title: string;
  whenToUse: string;
  draftSkillId: string | null;
  publishedSkillId: string | null;
};

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LEARNING_LIMITS.tags) break;
  }
  return out;
}

/** The lesson text reduced to letters and digits, hashed: the same lesson twice is one row. */
export function lessonHash(text: string): string {
  return createHash('sha256').update(skillKey(text)).digest('hex').slice(0, 40);
}

function settingsOf(raw: unknown): { showExpertName: boolean } {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { showExpertName: s.showExpertName === true };
}

/**
 * Learning projects (#1695). An admin turns learning on for ONE member on ONE
 * MCP server; what that member teaches the AI client there is kept as lessons
 * and rendered, per topic, into a skill.
 *
 * Two skill rows per topic. The draft holds every lesson and is served to the
 * expert only (`audienceUserId`), so they see the model improve at once. The
 * published row holds the confirmed lessons as of the last publication and is
 * served to everyone; it changes only when a person publishes.
 *
 * Nothing is stored before the member consents, the member can withdraw and
 * erase at any time, and their existing opt-out of skill learning stops every
 * project. A plan that no longer includes a project makes it inactive without
 * removing anything.
 */
@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);
  private readonly activeCache = new Map<string, { value: ActiveLearning | null; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LearningAccessService,
    private readonly skills: KgSkillService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ── Projects (admins) ────────────────────────────────────────────────────

  async create(
    organizationId: string,
    input: {
      name: string;
      userId: string;
      mcpServerId: string;
      folderId?: string | null;
      endsAt?: string | Date | null;
      tags?: unknown;
      publishMode?: string;
      showExpertName?: boolean;
    },
    ctx: LearningActionContext,
  ) {
    await this.endExpired(organizationId);
    await this.access.assertCanOpen(organizationId);
    const name = cleanText(input.name, 120);
    if (!name) throw new BadRequestException('A learning project needs a name.');

    const [member, server] = await Promise.all([
      this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: input.userId, organizationId } },
        select: { deactivatedAt: true },
      }),
      this.prisma.mcpServerConfig.findFirst({
        where: { id: input.mcpServerId, organizationId },
        select: { id: true },
      }),
    ]);
    if (!member || member.deactivatedAt) throw new NotFoundException('Member not found.');
    if (!server) throw new NotFoundException('MCP server not found.');
    const folderId = await this.ownFolder(organizationId, input.folderId);

    const existing = await this.prisma.learningProject.findFirst({
      where: {
        organizationId,
        userId: input.userId,
        mcpServerId: input.mcpServerId,
        status: { in: ['draft', 'active', 'paused'] },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('This member already has a learning project on this MCP server.');
    }

    const project = await this.prisma.learningProject.create({
      data: {
        organizationId,
        name,
        userId: input.userId,
        mcpServerId: input.mcpServerId,
        folderId,
        status: 'draft',
        publishMode: (PUBLISH_MODES as readonly string[]).includes(input.publishMode ?? '')
          ? (input.publishMode as string)
          : 'manual',
        tags: cleanTags(input.tags),
        settings: { showExpertName: input.showExpertName === true },
        endsAt: this.futureDate(input.endsAt),
        createdByUserId: ctx.actorUserId,
      },
    });
    await this.log(SecurityEvents.LEARNING_PROJECT_CREATED, organizationId, ctx, input.userId, {
      projectId: project.id,
      mcpServerId: input.mcpServerId,
    });
    return project;
  }

  async update(
    organizationId: string,
    id: string,
    patch: {
      name?: string;
      folderId?: string | null;
      endsAt?: string | Date | null;
      tags?: unknown;
      publishMode?: string;
      showExpertName?: boolean;
    },
  ) {
    const project = await this.owned(organizationId, id);
    const data: Record<string, unknown> = {};
    if (typeof patch.name === 'string') {
      const name = cleanText(patch.name, 120);
      if (!name) throw new BadRequestException('A learning project needs a name.');
      data.name = name;
    }
    // Applies to the skills of topics started from now on; existing skills
    // stay where they are (move them on the AI Skills page).
    if (patch.folderId !== undefined) data.folderId = await this.ownFolder(organizationId, patch.folderId);
    if (patch.endsAt !== undefined) data.endsAt = this.futureDate(patch.endsAt);
    if (patch.tags !== undefined) data.tags = cleanTags(patch.tags);
    if (patch.publishMode && (PUBLISH_MODES as readonly string[]).includes(patch.publishMode)) {
      data.publishMode = patch.publishMode;
    }
    if (typeof patch.showExpertName === 'boolean') {
      data.settings = { ...settingsOf(project.settings), showExpertName: patch.showExpertName };
    }
    const updated = await this.prisma.learningProject.update({ where: { id }, data });
    this.forgetActive(project);
    return updated;
  }

  /** Pause, resume or end a project. Ended is final: start a new project to continue. */
  async setStatus(
    organizationId: string,
    id: string,
    to: 'paused' | 'active' | 'ended',
    ctx: LearningActionContext,
  ) {
    const project = await this.owned(organizationId, id);
    if (project.status === to) return project;
    if (project.status === 'ended') throw new ConflictException('This learning project has ended.');
    if (to === 'paused' && project.status !== 'active') {
      throw new ConflictException('Only an active learning project can be paused.');
    }
    if (to === 'active') {
      if (project.status !== 'paused') {
        throw new ConflictException('A learning project becomes active when its member accepts it.');
      }
      // A paused project holds no place in the plan's number: ask again.
      await this.access.assertCanOpen(organizationId);
    }
    const updated = await this.prisma.learningProject.update({
      where: { id },
      data: { status: to, ...(to === 'ended' ? { endsAt: new Date() } : {}) },
    });
    // The member reads the published skills like everyone once it is over.
    if (to === 'ended') await this.dropDrafts(organizationId, id);
    this.forgetActive(project);
    await this.log(SecurityEvents.LEARNING_PROJECT_STATUS, organizationId, ctx, project.userId, {
      projectId: id,
      from: project.status,
      to,
    });
    return updated;
  }

  /** Delete a project with its lessons and drafts. Published skills stay. */
  async remove(organizationId: string, id: string, ctx: LearningActionContext) {
    const project = await this.owned(organizationId, id);
    const lessons = await this.prisma.learningLesson.count({ where: { organizationId, projectId: id } });
    await this.dropDrafts(organizationId, id);
    await this.prisma.learningProject.delete({ where: { id } });
    this.forgetActive(project);
    await this.log(SecurityEvents.LEARNING_ERASED, organizationId, ctx, project.userId, {
      projectId: id,
      lessons,
      via: 'admin',
    });
    return { ok: true, lessons };
  }

  // ── Reading (dashboard) ──────────────────────────────────────────────────

  /** The projects of a workspace. The expert's identity is for admins, unless the project shows it. */
  async list(organizationId: string, viewer: { isAdmin: boolean }) {
    await this.endExpired(organizationId);
    const [projects, usage] = await Promise.all([
      this.prisma.learningProject.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          mcpServer: { select: { id: true, name: true } },
          folder: { select: { id: true, name: true } },
          _count: { select: { topics: true } },
        },
        take: 200,
      }),
      this.access.usage(organizationId),
    ]);
    const ids = projects.map((p) => p.id);
    const counts = ids.length
      ? await this.prisma.learningLesson.groupBy({
          by: ['projectId', 'status'],
          where: { organizationId, projectId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const effective = await this.withinPlan(organizationId, usage.max);
    return {
      allowance: usage,
      projects: projects.map((p) => this.present(p, counts, viewer, effective)),
    };
  }

  async get(organizationId: string, id: string, viewer: { isAdmin: boolean }) {
    const project = await this.prisma.learningProject.findFirst({
      where: { id, organizationId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        mcpServer: { select: { id: true, name: true } },
        folder: { select: { id: true, name: true } },
        _count: { select: { topics: true } },
      },
    });
    if (!project) throw new NotFoundException('Learning project not found.');
    const [counts, topics, byTopic, usage] = await Promise.all([
      this.prisma.learningLesson.groupBy({
        by: ['projectId', 'status'],
        where: { organizationId, projectId: id },
        _count: { _all: true },
      }),
      this.prisma.learningTopic.findMany({
        where: { organizationId, projectId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.learningLesson.groupBy({
        by: ['topicId', 'status'],
        where: { organizationId, projectId: id },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      this.access.usage(organizationId),
    ]);
    const effective = await this.withinPlan(organizationId, usage.max);
    return {
      ...this.present(project, counts, viewer, effective),
      topics: topics.map((t) => {
        const rows = byTopic.filter((r) => r.topicId === t.id);
        const n = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
        const lastConfirmed = rows.find((r) => r.status === 'confirmed')?._max.updatedAt ?? null;
        return {
          id: t.id,
          title: t.title,
          whenToUse: t.whenToUse,
          draftSkillId: t.draftSkillId,
          publishedSkillId: t.publishedSkillId,
          publishedAt: t.publishedAt,
          lessons: { draft: n('draft'), confirmed: n('confirmed'), rejected: n('rejected') },
          // Confirmed lessons changed since the last publication.
          unpublished: n('confirmed') > 0 && (!t.publishedAt || (!!lastConfirmed && lastConfirmed > t.publishedAt)),
        };
      }),
    };
  }

  async lessons(
    organizationId: string,
    projectId: string,
    opts?: { status?: string; topicId?: string; take?: number; skip?: number },
  ) {
    await this.owned(organizationId, projectId);
    const where: Record<string, unknown> = { organizationId, projectId };
    if (opts?.status) where.status = opts.status;
    if (opts?.topicId) where.topicId = opts.topicId;
    const take = Math.min(Math.max(opts?.take ?? 50, 1), 200);
    const skip = Math.max(opts?.skip ?? 0, 0);
    const [items, total] = await Promise.all([
      this.prisma.learningLesson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { topic: { select: { title: true } } },
      }),
      this.prisma.learningLesson.count({ where }),
    ]);
    return { items, total, take, skip };
  }

  /** What Publish would write for a topic, without writing it. */
  async preview(organizationId: string, topicId: string) {
    const topic = await this.ownedTopic(organizationId, topicId);
    const lessons = await this.topicLessons(organizationId, topicId);
    return { topic: { id: topic.id, title: topic.title }, ...renderLearnedSkill(topic, lessons, 'published') };
  }

  // ── The member ───────────────────────────────────────────────────────────

  /** The caller's own projects in this workspace, for their profile. */
  async mine(organizationId: string, userId: string) {
    const projects = await this.prisma.learningProject.findMany({
      where: { organizationId, userId, status: { in: ['draft', 'active', 'paused'] } },
      orderBy: { createdAt: 'desc' },
      include: { mcpServer: { select: { id: true, name: true } } },
    });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      mcpServer: p.mcpServer,
      consentAt: p.consentAt,
      endsAt: p.endsAt,
      showExpertName: settingsOf(p.settings).showExpertName,
    }));
  }

  /** The member accepts: from now on their lessons are kept. */
  async consent(organizationId: string, projectId: string, userId: string, notice: string, ctx: LearningActionContext) {
    const project = await this.owned(organizationId, projectId);
    if (project.userId !== userId) throw new ForbiddenException('Only the member of a learning project can accept it.');
    if (project.status !== 'draft') throw new ConflictException('This learning project is not waiting for your answer.');
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { deactivatedAt: true, learningOptOut: true },
    });
    if (!member || member.deactivatedAt) throw new NotFoundException('Member not found.');
    if (member.learningOptOut) {
      throw new ConflictException(
        'You opted out of skill learning in this workspace. Remove the opt-out in your profile first.',
      );
    }
    const text = cleanText(notice, LEARNING_LIMITS.notice);
    if (!text) throw new BadRequestException('The notice you accept must be sent with the answer.');
    const now = new Date();
    const updated = await this.prisma.learningProject.update({
      where: { id: projectId },
      data: { status: 'active', consentAt: now, consentNotice: text, startsAt: project.startsAt ?? now },
    });
    this.forgetActive(project);
    await this.log(SecurityEvents.LEARNING_PROJECT_CONSENT, organizationId, ctx, userId, {
      projectId,
      given: true,
    });
    return updated;
  }

  /**
   * The member declines or stops, at any time. With `erase`, everything that
   * was not published goes: the drafts, the unconfirmed lessons and the
   * lessons of topics never published. What was published stays.
   */
  async withdraw(
    organizationId: string,
    projectId: string,
    userId: string,
    opts: { erase?: boolean },
    ctx: LearningActionContext,
  ) {
    const project = await this.owned(organizationId, projectId);
    if (project.userId !== userId) throw new ForbiddenException('Only the member of a learning project can stop it.');
    let erased = 0;
    if (project.status !== 'ended') {
      await this.prisma.learningProject.update({
        where: { id: projectId },
        data: { status: 'ended', endsAt: new Date() },
      });
    }
    await this.dropDrafts(organizationId, projectId);
    if (opts.erase) {
      const unpublished = await this.prisma.learningTopic.findMany({
        where: { organizationId, projectId, publishedSkillId: null },
        select: { id: true },
      });
      const res = await this.prisma.learningLesson.deleteMany({
        where: {
          organizationId,
          projectId,
          OR: [{ status: { not: 'confirmed' } }, { topicId: { in: unpublished.map((t) => t.id) } }],
        },
      });
      erased = res.count;
      await this.prisma.learningTopic.deleteMany({
        where: { organizationId, projectId, publishedSkillId: null },
      });
    }
    this.forgetActive(project);
    await this.log(SecurityEvents.LEARNING_PROJECT_CONSENT, organizationId, ctx, userId, {
      projectId,
      given: false,
      erased,
    });
    if (opts.erase) {
      await this.log(SecurityEvents.LEARNING_ERASED, organizationId, ctx, userId, {
        projectId,
        lessons: erased,
        via: 'self',
      });
    }
    return { ok: true, erased };
  }

  // ── The MCP endpoint ─────────────────────────────────────────────────────

  /**
   * The active project of this caller on this server, or null. Checked on MCP
   * requests, so the answer (also "none") is kept for a minute. Fails closed:
   * no user, no project, no consent, an opt-out, a deactivated member, a plan
   * without learning projects or past its number all give null.
   */
  async activeFor(
    organizationId: string,
    userId: string | null | undefined,
    mcpServerId: string,
    now = new Date(),
  ): Promise<ActiveLearning | null> {
    if (!organizationId || !userId || !mcpServerId) return null;
    const key = `${organizationId}|${userId}|${mcpServerId}`;
    const hit = this.activeCache.get(key);
    if (hit && now.getTime() - hit.at < ACTIVE_CACHE_MS) return hit.value;
    const value = await this.findActive(organizationId, userId, mcpServerId, now);
    if (this.activeCache.size >= ACTIVE_CACHE_MAX) this.activeCache.clear();
    this.activeCache.set(key, { value, at: now.getTime() });
    return value;
  }

  private async findActive(
    organizationId: string,
    userId: string,
    mcpServerId: string,
    now: Date,
  ): Promise<ActiveLearning | null> {
    const project = await this.prisma.learningProject.findFirst({
      where: { organizationId, userId, mcpServerId, status: 'active', consentAt: { not: null } },
      select: { id: true, name: true, consentAt: true, startsAt: true, endsAt: true, createdAt: true },
    });
    if (!project || !project.consentAt) return null;
    if (project.startsAt && project.startsAt > now) return null;
    if (project.endsAt && project.endsAt <= now) {
      await this.endExpired(organizationId, now).catch((e: any) =>
        this.logger.warn(`Ending expired learning projects of ${organizationId} failed: ${e?.message ?? e}`),
      );
      return null;
    }

    const [member, allowance] = await Promise.all([
      this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { deactivatedAt: true, learningOptOut: true },
      }),
      this.access.allowance(organizationId, now),
    ]);
    if (!member || member.deactivatedAt || member.learningOptOut) return null;
    if (allowance.max === 0) return null;
    if (allowance.max !== null) {
      // After a downgrade the oldest projects keep working, up to the plan's number.
      const older = await this.prisma.learningProject.count({
        where: {
          organizationId,
          status: { in: [...LEARNING_OPEN_STATUSES] },
          createdAt: { lt: project.createdAt },
        },
      });
      if (older >= allowance.max) return null;
    }
    const topics = await this.prisma.learningTopic.findMany({
      where: { organizationId, projectId: project.id },
      select: { id: true, title: true, whenToUse: true },
      orderBy: { createdAt: 'asc' },
      take: LEARNING_LIMITS.topics,
    });
    return {
      projectId: project.id,
      organizationId,
      userId,
      mcpServerId,
      name: project.name,
      consentAt: project.consentAt,
      full: allowance.full,
      topics,
    };
  }

  // ── Lessons ──────────────────────────────────────────────────────────────

  /** Keep one lesson and render it into the topic's draft. */
  async record(active: { projectId: string; organizationId: string }, input: RecordLessonInput) {
    const { organizationId, projectId } = active;
    const project = await this.owned(organizationId, projectId);
    if (project.status !== 'active') throw new ConflictException('This learning project is not active.');

    const kind = (LESSON_KINDS as readonly string[]).includes(input.kind) ? (input.kind as LessonKind) : null;
    if (!kind) throw new BadRequestException(`"kind" is one of: ${LESSON_KINDS.join(', ')}.`);
    const text = cleanText(input.text, LEARNING_LIMITS.text);
    if (text.length < 10) throw new BadRequestException('Write the lesson in a full sentence (at least 10 characters).');
    const detail: LessonDetail = {
      before: cleanText(input.before, LEARNING_LIMITS.detail) || undefined,
      after: cleanText(input.after, LEARNING_LIMITS.detail) || undefined,
      reason: cleanText(input.reason, LEARNING_LIMITS.detail) || undefined,
      tool: cleanText(input.tool, 120) || undefined,
      needsReason: input.source === 'diff' ? true : undefined,
    };
    const whole = [text, detail.before, detail.after, detail.reason].filter(Boolean).join('\n');
    if (looksLikeSecret(whole)) {
      throw new BadRequestException('This looks like a password, token or key. Lessons never hold secrets.');
    }
    if (looksLikeInjection(whole)) {
      throw new BadRequestException(
        'A lesson describes how the work is done. It cannot tell the assistant to ignore its instructions.',
      );
    }

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [total, lastHour] = await Promise.all([
      this.prisma.learningLesson.count({ where: { organizationId, projectId } }),
      this.prisma.learningLesson.count({ where: { organizationId, projectId, createdAt: { gt: since } } }),
    ]);
    if (lastHour >= LEARNING_LIMITS.lessonsPerHour) {
      throw new BadRequestException('Many lessons were saved in the last hour. Save the next ones later.');
    }
    if (total >= LEARNING_LIMITS.lessons) {
      throw new BadRequestException(`This learning project holds ${LEARNING_LIMITS.lessons} lessons, its limit.`);
    }

    const topic = await this.topicFor(project, input.topic, input.whenToUse);
    const inTopic = await this.prisma.learningLesson.count({ where: { organizationId, topicId: topic.id } });

    const textHash = lessonHash(text);
    const existing = await this.prisma.learningLesson.findUnique({
      where: { topicId_textHash: { topicId: topic.id, textHash } },
      select: { id: true, status: true },
    });
    let lessonId: string;
    let repeated = false;
    if (existing) {
      // Said again: counted, and brought back if it had been set aside.
      repeated = true;
      lessonId = existing.id;
      await this.prisma.learningLesson.update({
        where: { id: existing.id },
        data: {
          seenCount: { increment: 1 },
          ...(existing.status === 'rejected' || existing.status === 'superseded'
            ? { status: 'draft', supersededById: null }
            : {}),
        },
      });
    } else {
      if (inTopic >= LEARNING_LIMITS.lessonsPerTopic) {
        throw new BadRequestException(
          `The topic "${topic.title}" holds ${LEARNING_LIMITS.lessonsPerTopic} lessons. File this one under a narrower topic.`,
        );
      }
      try {
        const created = await this.prisma.learningLesson.create({
          data: {
            organizationId,
            projectId,
            topicId: topic.id,
            kind,
            text,
            detail: detail as object,
            textHash,
            status: 'draft',
            source: input.source ?? 'model',
          },
          select: { id: true },
        });
        lessonId = created.id;
      } catch (e: any) {
        // The same lesson saved twice at the same moment: one row, as above.
        if (e?.code !== 'P2002') throw e;
        const twin = await this.prisma.learningLesson.findUnique({
          where: { topicId_textHash: { topicId: topic.id, textHash } },
          select: { id: true },
        });
        if (!twin) throw e;
        repeated = true;
        lessonId = twin.id;
      }
    }

    if (input.replaces && input.replaces !== lessonId) {
      await this.prisma.learningLesson.updateMany({
        where: { id: input.replaces, organizationId, projectId, status: { in: ['draft', 'confirmed'] } },
        data: { status: 'superseded', supersededById: lessonId },
      });
    }

    const rendered = await this.renderDraft(project, topic.id);
    this.forgetActive(project);
    return {
      id: lessonId,
      topicId: topic.id,
      topic: topic.title,
      lessonsInTopic: rendered.included + rendered.dropped,
      repeated,
      // The text reached its size: newer lessons belong in a narrower topic.
      large: rendered.dropped > 0,
    };
  }

  /** The lessons the expert has not confirmed yet; those the server observed without a reason first. */
  async review(active: { projectId: string; organizationId: string }, opts?: { topic?: string; limit?: number }) {
    const { organizationId, projectId } = active;
    const where: Record<string, unknown> = { organizationId, projectId, status: 'draft' };
    if (opts?.topic?.trim()) {
      const topic = await this.prisma.learningTopic.findUnique({
        where: { projectId_key: { projectId, key: skillKey(opts.topic).slice(0, LEARNING_LIMITS.title) } },
        select: { id: true },
      });
      if (!topic) return { lessons: [], remaining: 0 };
      where.topicId = topic.id;
    }
    const limit = Math.min(Math.max(opts?.limit ?? LEARNING_LIMITS.review, 1), LEARNING_LIMITS.review);
    const [rows, total] = await Promise.all([
      this.prisma.learningLesson.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: { topic: { select: { title: true } } },
      }),
      this.prisma.learningLesson.count({ where }),
    ]);
    const sorted = [...rows].sort(
      (a, b) => Number(!!lessonDetail(b.detail).needsReason) - Number(!!lessonDetail(a.detail).needsReason),
    );
    const lessons = sorted.slice(0, limit).map((l) => {
      const d = lessonDetail(l.detail);
      return {
        id: l.id,
        topic: l.topic.title,
        kind: l.kind,
        text: l.text,
        before: d.before,
        after: d.after,
        reason: d.reason,
        askWhy: d.needsReason === true,
      };
    });
    return { lessons, remaining: total - lessons.length };
  }

  /** The expert's verdicts on lessons: right, wrong, or right in other words. */
  async confirm(
    active: { projectId: string; organizationId: string },
    decisions: LessonDecision[],
    userId: string,
  ) {
    const { organizationId, projectId } = active;
    const project = await this.owned(organizationId, projectId);
    const result = { confirmed: 0, rejected: 0, corrected: 0, notFound: [] as string[] };
    const touched = new Set<string>();
    const now = new Date();

    for (const d of (decisions ?? []).slice(0, LEARNING_LIMITS.decisions)) {
      const lesson = await this.prisma.learningLesson.findFirst({
        where: { id: d?.id, organizationId, projectId, status: { in: ['draft', 'confirmed'] } },
      });
      if (!lesson) {
        result.notFound.push(String(d?.id ?? ''));
        continue;
      }
      const reason = cleanText(d.reason, LEARNING_LIMITS.detail);
      const detail = { ...lessonDetail(lesson.detail) };
      if (reason) {
        if (looksLikeSecret(reason) || looksLikeInjection(reason)) {
          throw new BadRequestException('The reason cannot hold a secret or instructions for the assistant.');
        }
        detail.reason = reason;
        delete detail.needsReason;
      }

      if (d.verdict === 'reject') {
        await this.prisma.learningLesson.update({ where: { id: lesson.id }, data: { status: 'rejected' } });
        result.rejected++;
      } else if (d.verdict === 'correct') {
        const text = cleanText(d.text, LEARNING_LIMITS.text);
        if (text.length < 10) throw new BadRequestException('A correction needs the corrected lesson as "text".');
        if (looksLikeSecret(text) || looksLikeInjection(text)) {
          throw new BadRequestException('A lesson cannot hold a secret or instructions for the assistant.');
        }
        delete detail.needsReason;
        const textHash = lessonHash(text);
        // The corrected wording may already exist in the topic.
        const same = await this.prisma.learningLesson.findUnique({
          where: { topicId_textHash: { topicId: lesson.topicId, textHash } },
          select: { id: true },
        });
        const data = { status: 'confirmed', confirmedAt: now, confirmedByUserId: userId, supersededById: null };
        const next = same
          ? await this.prisma.learningLesson.update({ where: { id: same.id }, data, select: { id: true } })
          : await this.prisma.learningLesson.create({
              data: {
                organizationId,
                projectId,
                topicId: lesson.topicId,
                kind: lesson.kind,
                text,
                detail: detail as object,
                textHash,
                source: lesson.source,
                ...data,
              },
              select: { id: true },
            });
        if (next.id !== lesson.id) {
          await this.prisma.learningLesson.update({
            where: { id: lesson.id },
            data: { status: 'superseded', supersededById: next.id },
          });
        }
        result.corrected++;
      } else {
        await this.prisma.learningLesson.update({
          where: { id: lesson.id },
          data: { status: 'confirmed', confirmedAt: now, confirmedByUserId: userId, detail: detail as object },
        });
        result.confirmed++;
      }
      touched.add(lesson.topicId);
    }

    for (const topicId of touched) {
      await this.renderDraft(project, topicId);
      if (project.publishMode === 'confirmed') {
        await this.publish(organizationId, topicId, { actorUserId: userId }).catch((e: any) =>
          this.logger.warn(`Publishing topic ${topicId} after confirmation failed: ${e?.message ?? e}`),
        );
      }
    }
    return result;
  }

  /** A curator's change to one lesson in the dashboard. */
  async setLesson(
    organizationId: string,
    lessonId: string,
    patch: { status?: string; text?: string },
    ctx: LearningActionContext,
  ) {
    const lesson = await this.prisma.learningLesson.findFirst({ where: { id: lessonId, organizationId } });
    if (!lesson) throw new NotFoundException('Lesson not found.');
    const active = { projectId: lesson.projectId, organizationId };
    const wantsVerdict =
      patch.status === 'confirmed' || (typeof patch.text === 'string' && patch.text.trim() !== lesson.text);
    if (wantsVerdict && (lesson.status === 'rejected' || lesson.status === 'superseded')) {
      // A lesson that was set aside comes back before it gets a verdict.
      await this.prisma.learningLesson.update({
        where: { id: lessonId },
        data: { status: 'draft', supersededById: null },
      });
    }
    if (typeof patch.text === 'string' && patch.text.trim() && patch.text.trim() !== lesson.text) {
      await this.confirm(active, [{ id: lessonId, verdict: 'correct', text: patch.text }], ctx.actorUserId);
    } else if (patch.status === 'confirmed') {
      await this.confirm(active, [{ id: lessonId, verdict: 'confirm' }], ctx.actorUserId);
    } else if (patch.status === 'rejected') {
      await this.confirm(active, [{ id: lessonId, verdict: 'reject' }], ctx.actorUserId);
    } else if (patch.status === 'draft' && lesson.status !== 'draft') {
      await this.prisma.learningLesson.update({
        where: { id: lessonId },
        data: { status: 'draft', confirmedAt: null, confirmedByUserId: null, supersededById: null },
      });
      await this.renderDraft(await this.owned(organizationId, lesson.projectId), lesson.topicId);
    }
    return this.prisma.learningLesson.findFirst({ where: { id: lessonId, organizationId } });
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  /**
   * Write a topic's confirmed lessons into its published skill, the one
   * everyone is served. An existing skill keeps its id and gets a new version;
   * a skill an admin dismissed stays dismissed.
   */
  async publish(organizationId: string, topicId: string, ctx: LearningActionContext) {
    const topic = await this.ownedTopic(organizationId, topicId);
    const project = await this.owned(organizationId, topic.projectId);
    if (!project.mcpServerId) {
      throw new ConflictException('The MCP server of this learning project no longer exists.');
    }
    const lessons = await this.topicLessons(organizationId, topicId);
    const rendered = renderLearnedSkill(topic, lessons, 'published');
    if (!rendered.body) throw new ConflictException('No confirmed lesson to publish in this topic yet.');

    const content = {
      title: topic.title,
      whenToUse: topic.whenToUse,
      instruction: rendered.instruction,
      body: rendered.body,
    };
    const current = topic.publishedSkillId
      ? await this.prisma.kgSkillSuggestion.findFirst({
          where: { id: topic.publishedSkillId, organizationId },
          select: { id: true },
        })
      : null;
    let skillId: string;
    if (current) {
      await this.skills.update(organizationId, current.id, content, ctx.actorUserId);
      await this.prisma.kgSkillSuggestion.update({
        where: { id: current.id },
        data: { evidenceCount: rendered.included },
      });
      skillId = current.id;
    } else {
      const created = await this.prisma.kgSkillSuggestion.create({
        data: {
          organizationId,
          mcpServerId: project.mcpServerId,
          folderId: project.folderId,
          ...content,
          confidence: 1,
          evidenceCount: rendered.included,
          status: 'applied',
          source: 'learning',
          learningProjectId: project.id,
          originUserId: project.userId,
          audienceUserId: null,
          tags: [...new Set([...cleanTags(project.tags), 'learned'])],
        },
        select: { id: true },
      });
      skillId = created.id;
    }
    await this.prisma.learningTopic.update({
      where: { id: topicId },
      data: { publishedSkillId: skillId, publishedAt: new Date() },
    });
    await this.log(SecurityEvents.LEARNING_PUBLISHED, organizationId, ctx, project.userId, {
      projectId: project.id,
      topicId,
      skillId,
      lessons: rendered.included,
    });
    return { skillId, lessons: rendered.included, dropped: rendered.dropped };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Render every lesson of a topic into the skill only the expert is served. */
  private async renderDraft(project: ProjectRow, topicId: string) {
    const organizationId = project.organizationId;
    const topic = await this.ownedTopic(organizationId, topicId);
    const lessons = await this.topicLessons(organizationId, topicId);
    const rendered = renderLearnedSkill(topic, lessons, 'draft');
    const current = topic.draftSkillId
      ? await this.prisma.kgSkillSuggestion.findFirst({
          where: { id: topic.draftSkillId, organizationId },
          select: { id: true },
        })
      : null;

    // Without a member there is nobody to draft for.
    if (!rendered.body || !project.userId || !project.mcpServerId) {
      if (current) await this.prisma.kgSkillSuggestion.delete({ where: { id: current.id } });
      return rendered;
    }
    const content = {
      title: topic.title,
      whenToUse: topic.whenToUse,
      instruction: rendered.instruction,
      body: rendered.body,
      evidenceCount: rendered.included,
    };
    if (current) {
      // Re-rendered on every lesson: no version history for a draft.
      await this.prisma.kgSkillSuggestion.update({ where: { id: current.id }, data: content });
      return rendered;
    }
    const created = await this.prisma.kgSkillSuggestion.create({
      data: {
        organizationId,
        mcpServerId: project.mcpServerId,
        folderId: project.folderId,
        ...content,
        confidence: 1,
        status: 'applied',
        source: 'learning',
        learningProjectId: project.id,
        originUserId: project.userId,
        // Served to the expert only (audienceVisibility in kg-skill.service).
        audienceUserId: project.userId,
        tags: [...new Set([...cleanTags(project.tags), 'learned', 'draft'])],
      },
      select: { id: true },
    });
    await this.prisma.learningTopic.update({ where: { id: topicId }, data: { draftSkillId: created.id } });
    return rendered;
  }

  private async topicFor(project: ProjectRow, rawTitle: string, rawWhen?: string): Promise<TopicRow> {
    const title = cleanText(rawTitle, LEARNING_LIMITS.title).replace(/\n/g, ' ');
    const key = skillKey(title).slice(0, LEARNING_LIMITS.title);
    if (!key) throw new BadRequestException('A lesson needs a topic.');
    if (looksLikeSecret(title) || looksLikeInjection(title)) {
      throw new BadRequestException('A topic is a short name for a kind of work.');
    }
    const found = await this.prisma.learningTopic.findUnique({
      where: { projectId_key: { projectId: project.id, key } },
    });
    if (found) return found;
    const count = await this.prisma.learningTopic.count({
      where: { organizationId: project.organizationId, projectId: project.id },
    });
    if (count >= LEARNING_LIMITS.topics) {
      throw new BadRequestException(
        `This learning project has ${LEARNING_LIMITS.topics} topics, its limit. File the lesson under an existing topic.`,
      );
    }
    const whenToUse = cleanText(rawWhen, LEARNING_LIMITS.whenToUse).replace(/\n/g, ' ');
    if (whenToUse && (looksLikeSecret(whenToUse) || looksLikeInjection(whenToUse))) {
      throw new BadRequestException('"whenToUse" says when the skill applies.');
    }
    return this.prisma.learningTopic.create({
      data: { organizationId: project.organizationId, projectId: project.id, title, key, whenToUse },
    });
  }

  private topicLessons(organizationId: string, topicId: string) {
    return this.prisma.learningLesson.findMany({
      where: { organizationId, topicId, status: { in: ['draft', 'confirmed'] } },
      select: { id: true, kind: true, text: true, status: true, detail: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * A project past its end date ends: it frees its place in the plan's
   * number and its member reads the published skills like everyone.
   */
  private async endExpired(organizationId: string, now = new Date()): Promise<void> {
    const expired = await this.prisma.learningProject.findMany({
      where: { organizationId, status: { in: ['draft', 'active', 'paused'] }, endsAt: { lte: now } },
      select: { id: true, organizationId: true, userId: true, mcpServerId: true },
    });
    for (const p of expired) {
      await this.prisma.learningProject.update({ where: { id: p.id }, data: { status: 'ended' } });
      await this.dropDrafts(organizationId, p.id);
      this.forgetActive(p);
    }
  }

  /** Delete a project's drafts: the skills served to its member only. */
  private async dropDrafts(organizationId: string, projectId: string): Promise<void> {
    await this.prisma.kgSkillSuggestion.deleteMany({
      where: { organizationId, learningProjectId: projectId, audienceUserId: { not: null } },
    });
  }

  /** Ids of the open projects the plan's number covers (the oldest ones); null = all. */
  private async withinPlan(organizationId: string, max: number | null): Promise<Set<string> | null> {
    if (max === null) return null;
    const open = await this.prisma.learningProject.findMany({
      where: { organizationId, status: { in: [...LEARNING_OPEN_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: Math.max(max, 0),
    });
    return new Set(open.map((p) => p.id));
  }

  private present(
    p: any,
    counts: Array<{ projectId: string; status: string; _count: { _all: number } }>,
    viewer: { isAdmin: boolean },
    effective: Set<string> | null,
  ) {
    const n = (status: string) =>
      counts.find((c) => c.projectId === p.id && c.status === status)?._count._all ?? 0;
    const settings = settingsOf(p.settings);
    const open = (LEARNING_OPEN_STATUSES as readonly string[]).includes(p.status);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      // Open, but past the number the plan includes: nothing is captured.
      overPlan: open && effective !== null && !effective.has(p.id),
      publishMode: p.publishMode,
      tags: cleanTags(p.tags),
      showExpertName: settings.showExpertName,
      // Who it is learned from: admins, or everyone when the project says so.
      expert: p.user
        ? viewer.isAdmin
          ? { id: p.user.id, name: p.user.name, email: p.user.email }
          : settings.showExpertName
            ? { id: p.user.id, name: p.user.name }
            : null
        : null,
      mcpServer: p.mcpServer ?? null,
      folder: p.folder ?? null,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      consentAt: p.consentAt,
      createdAt: p.createdAt,
      topics: p._count?.topics ?? 0,
      lessons: { draft: n('draft'), confirmed: n('confirmed'), rejected: n('rejected') },
    };
  }

  private async owned(organizationId: string, id: string): Promise<ProjectRow> {
    const project = await this.prisma.learningProject.findFirst({ where: { id, organizationId } });
    if (!project) throw new NotFoundException('Learning project not found.');
    return project;
  }

  private async ownedTopic(organizationId: string, id: string): Promise<TopicRow> {
    const topic = await this.prisma.learningTopic.findFirst({ where: { id, organizationId } });
    if (!topic) throw new NotFoundException('Topic not found.');
    return topic;
  }

  private async ownFolder(organizationId: string, folderId?: string | null): Promise<string | null> {
    if (!folderId) return null;
    const f = await this.prisma.knowledgeFolder.findFirst({
      where: { id: folderId, organizationId },
      select: { id: true },
    });
    if (!f) throw new NotFoundException('Folder not found.');
    return f.id;
  }

  private futureDate(raw: string | Date | null | undefined): Date | null {
    if (!raw) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('The end date is not a date.');
    if (d.getTime() <= Date.now()) throw new BadRequestException('The end date must be in the future.');
    return d;
  }

  private forgetActive(project: { organizationId: string; userId: string | null; mcpServerId: string | null }): void {
    if (project.userId && project.mcpServerId) {
      this.activeCache.delete(`${project.organizationId}|${project.userId}|${project.mcpServerId}`);
    }
  }

  private async log(
    event: string,
    organizationId: string,
    ctx: LearningActionContext,
    targetUserId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.securityEvents.log({
      event,
      actorType: 'USER',
      organizationId,
      actorUserId: ctx.actorUserId,
      targetUserId: targetUserId ?? undefined,
      metadata,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
