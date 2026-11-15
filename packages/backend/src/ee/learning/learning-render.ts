import { SKILL_BODY_MAX } from '../../knowledge-graph/kg-skill.service';

/**
 * A learned skill is rendered from the lessons of its topic, never written as
 * a whole: adding a lesson cannot lose another one, and every sentence has an
 * origin. Pure functions, so the same lessons always give the same text.
 */

export const LESSON_KINDS = ['rule', 'fact', 'correction', 'example'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export const LESSON_STATUSES = ['draft', 'confirmed', 'rejected', 'superseded'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export interface LessonDetail {
  /** What the model did or proposed. */
  before?: string;
  /** What the expert changed it to. */
  after?: string;
  /** The expert's reason, in their words. */
  reason?: string;
  /** The tool the lesson is about. */
  tool?: string;
  /** Observed by the server, not explained yet: ask the expert why. */
  needsReason?: boolean;
}

export interface RenderLesson {
  id: string;
  kind: string;
  text: string;
  status: string;
  detail?: unknown;
  createdAt: Date;
}

export interface RenderedSkill {
  /** Short version (the skill's `instruction`): the first rules, on one line. */
  instruction: string;
  /** Everything (the skill's `body`), or null without lessons. */
  body: string | null;
  /** Lessons in the text. */
  included: number;
  /** Lessons left out because the text reached its size limit. */
  dropped: number;
}

/** Longest `instruction` of a learned skill; the body carries the rest. */
export const LEARNED_INSTRUCTION_MAX = 700;

const SECTIONS: Array<{ kind: LessonKind; heading: string }> = [
  { kind: 'rule', heading: 'Rules' },
  { kind: 'correction', heading: 'Corrections' },
  { kind: 'fact', heading: 'Facts' },
  { kind: 'example', heading: 'Examples' },
];

/** When the text is too long, lessons leave it in this order, oldest first. */
const DROP_ORDER: LessonKind[] = ['example', 'fact', 'correction', 'rule'];

export function lessonDetail(raw: unknown): LessonDetail {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const d = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    before: str(d.before),
    after: str(d.after),
    reason: str(d.reason),
    tool: str(d.tool),
    needsReason: d.needsReason === true ? true : undefined,
  };
}

/** One sentence, with its full stop. */
function sentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return /[.!?:;]$/.test(flat) ? flat : `${flat}.`;
}

function lessonLine(lesson: RenderLesson): string {
  const d = lessonDetail(lesson.detail);
  const parts = [lesson.text.trim()];
  if (d.before && d.after) parts.push(`Instead of: ${sentence(d.before)} Use: ${sentence(d.after)}`);
  else if (d.after) parts.push(`Use: ${sentence(d.after)}`);
  if (d.reason) parts.push(`Why: ${sentence(d.reason)}`);
  // Keep a multi-line lesson (a worked example) readable under its bullet.
  return `- ${parts.join('\n').replace(/\n/g, '\n  ')}`;
}

/**
 * The lessons that belong in the text: for the expert's draft everything not
 * rejected or superseded; for the published skill only what the expert
 * confirmed. Confirmed lessons first, then by age.
 */
export function lessonsFor(lessons: RenderLesson[], audience: 'draft' | 'published'): RenderLesson[] {
  const wanted = audience === 'draft' ? ['confirmed', 'draft'] : ['confirmed'];
  return lessons
    .filter((l) => wanted.includes(l.status))
    .sort(
      (a, b) =>
        wanted.indexOf(a.status) - wanted.indexOf(b.status) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
}

function bodyOf(lessons: RenderLesson[]): string {
  return SECTIONS.map(({ kind, heading }) => {
    const lines = lessons.filter((l) => l.kind === kind).map(lessonLine);
    return lines.length ? `## ${heading}\n${lines.join('\n')}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
}

export function renderLearnedSkill(
  topic: { title: string },
  all: RenderLesson[],
  audience: 'draft' | 'published',
  max = SKILL_BODY_MAX,
): RenderedSkill {
  let lessons = lessonsFor(all, audience);
  const total = lessons.length;
  if (!total) return { instruction: '', body: null, included: 0, dropped: 0 };

  let body = bodyOf(lessons);
  // Too long: the oldest examples go first, rules last. They stay stored.
  for (const kind of DROP_ORDER) {
    while (body.length > max) {
      const oldest = lessons
        .filter((l) => l.kind === kind)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (!oldest || lessons.length === 1) break;
      lessons = lessons.filter((l) => l.id !== oldest.id);
      body = bodyOf(lessons);
    }
  }
  if (body.length > max) body = `${body.slice(0, max - 1)}…`;

  // The short version: rules and corrections first, as plain sentences.
  const lead = [...lessons].sort(
    (a, b) => DROP_ORDER.indexOf(b.kind as LessonKind) - DROP_ORDER.indexOf(a.kind as LessonKind),
  );
  let instruction = '';
  for (const l of lead) {
    const next = sentence(l.text);
    if (instruction && instruction.length + next.length + 1 > LEARNED_INSTRUCTION_MAX) break;
    instruction = instruction ? `${instruction} ${next}` : next;
  }
  if (instruction.length > LEARNED_INSTRUCTION_MAX) {
    instruction = `${instruction.slice(0, LEARNED_INSTRUCTION_MAX - 1)}…`;
  }
  if (!instruction) instruction = `Lessons on ${topic.title}.`;

  return { instruction, body, included: lessons.length, dropped: total - lessons.length };
}
