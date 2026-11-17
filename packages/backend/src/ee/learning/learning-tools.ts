import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { LESSON_KINDS } from './learning-render';
import { ActiveLearning, LEARNING_LIMITS, LearningService } from './learning.service';

/**
 * The MCP tools of a learning project (#1695), offered on `/mcp/<serverId>`
 * to the project's member only. The member's own AI client saw the whole
 * conversation, so it is the one that turns a correction into a lesson; the
 * server stores it, renders the topic's skill and serves it back.
 */
export const LEARNING_RECORD_TOOL = 'learning_record';
export const LEARNING_REVIEW_TOOL = 'learning_review';
export const LEARNING_CONFIRM_TOOL = 'learning_confirm';

export interface LearningToolEntry {
  name: string;
  /** Changes when the tool's description or schema would. */
  sig: string;
  register: (mcpServer: McpServer) => unknown;
}

function oneLine(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Added to the server's instructions for the project's member. */
export function learningInstruction(active: ActiveLearning): string {
  return (
    '## Learning project\n' +
    `Learning project "${oneLine(active.name, 80)}" is on for this user on this server: they agreed on ` +
    `${day(active.consentAt)} that what they teach you here is kept as skills for their colleagues, and they ` +
    'can stop it in their AnythingMCP profile. When the user corrects something you did, explains a rule, or ' +
    `tells you how the work is really done, call ${LEARNING_RECORD_TOOL}. When they ask what you have learned, ` +
    `call ${LEARNING_REVIEW_TOOL}.`
  );
}

/**
 * Appended to the result of a tool that changes something. Some clients never
 * show a server's instructions to the model, and a correction usually follows
 * such a result, so this is where the reminder is read at the right moment.
 */
export function learningFooter(active: ActiveLearning): string {
  return (
    `Learning project "${oneLine(active.name, 80)}": if the user corrects this result or explains why it ` +
    `should be different, call ${LEARNING_RECORD_TOOL} before you continue.`
  );
}

/** A read result carries the reminder at most this often per project (#1770). */
export const READ_REMINDER_INTERVAL_MS = 10 * 60_000;
const READ_REMINDER_MAX = 5000;
const lastReadReminder = new Map<string, number>();

/**
 * Whether a read tool's result should carry the reminder now. An expert who
 * mostly reads (reports, price lists, read-only SQL) would otherwise never
 * see it; on every read result it would be noise. Per process: after a
 * restart, or on another instance, the next read result carries it again.
 */
export function readReminderDue(projectId: string, now = Date.now()): boolean {
  const last = lastReadReminder.get(projectId);
  if (last !== undefined && now - last < READ_REMINDER_INTERVAL_MS) return false;
  if (lastReadReminder.size >= READ_REMINDER_MAX) lastReadReminder.clear();
  lastReadReminder.set(projectId, now);
  return true;
}

/** For tests. */
export function resetReadReminders(): void {
  lastReadReminder.clear();
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(err: any) {
  const message = err?.response?.message ?? err?.message ?? String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: Array.isArray(message) ? message.join(' ') : String(message) }],
  };
}

const ENDED = 'This learning project is not active any more. Nothing was saved.';

/**
 * The three tools for one caller. Every call asks again whether the project
 * is still active, so a withdrawal, a pause or an opt-out applies at once,
 * also in a long-lived session.
 */
export function learningToolEntries(svc: LearningService, active: ActiveLearning): LearningToolEntry[] {
  const name = oneLine(active.name, 80);
  const topics = active.topics.map((t) => oneLine(t.title, LEARNING_LIMITS.title));
  const topicList = topics.length
    ? `Topics of this project: ${active.topics
        .slice(0, 20)
        .map((t) => {
          const when = oneLine(t.whenToUse ?? '', 80);
          return `"${oneLine(t.title, LEARNING_LIMITS.title)}"${when ? ` (${when})` : ''}`;
        })
        .join(', ')}${topics.length > 20 ? ', …' : ''}. ` +
      'File the lesson under the one it belongs to, with its exact name; start a new topic only when none fits.'
    : 'No topic yet: name the kind of work this lesson is about, e.g. "Quotes for old windows".';
  const base = `${active.projectId}:${name}`;
  const current = () => svc.activeFor(active.organizationId, active.userId, active.mcpServerId);

  return [
    {
      name: LEARNING_RECORD_TOOL,
      sig: `${LEARNING_RECORD_TOOL}:${base}:${topicList}`,
      register: (mcpServer: McpServer) =>
        mcpServer.registerTool(
          LEARNING_RECORD_TOOL,
          {
            description:
              `Learning project "${name}" is on for this user: they agreed on ${day(active.consentAt)} that what ` +
              'they teach you on this server is kept as a skill for their colleagues. Call this when the user ' +
              'corrects something you did, explains a rule, or tells you how the work is really done. Write the ' +
              'lesson as you would tell a new colleague, with article numbers, model names and quantities. No ' +
              'names of customers or other people, no passwords. One lesson per call. Then tell the user in one ' +
              'sentence what you saved.',
            inputSchema: {
              topic: z.string().min(2).max(LEARNING_LIMITS.title).describe(`The kind of work the lesson is about. ${topicList}`),
              kind: z
                .enum(LESSON_KINDS)
                .describe(
                  'rule: how to do it. correction: you did it differently and the user changed it. ' +
                    'fact: something that is true (which part fits which model). example: a finished case worth copying.',
                ),
              text: z
                .string()
                .min(10)
                .max(LEARNING_LIMITS.text)
                .describe('What to do next time, in a full sentence the user would agree with.'),
              before: z.string().max(LEARNING_LIMITS.detail).optional().describe('For a correction: what you did or proposed.'),
              after: z.string().max(LEARNING_LIMITS.detail).optional().describe('For a correction: what the user changed it to.'),
              reason: z.string().max(LEARNING_LIMITS.detail).optional().describe("The user's reason, in their words, when they gave one."),
              tool: z.string().max(120).optional().describe('The tool the lesson is about, when it is about one.'),
              whenToUse: z
                .string()
                .max(LEARNING_LIMITS.whenToUse)
                .optional()
                .describe('Only when starting a new topic: when a colleague\'s assistant should use this skill.'),
              replaces: z
                .string()
                .max(64)
                .optional()
                .describe('The id of an earlier lesson this one corrects (from learning_review or an earlier answer).'),
            },
            annotations: {
              title: 'Save a lesson',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async (args: any) => {
            try {
              const now = await current();
              if (!now) return failure(new Error(ENDED));
              const saved = await svc.record(now, { ...(args ?? {}), source: 'model' });
              return ok({
                saved: true,
                id: saved.id,
                topic: saved.topic,
                lessonsInTopic: saved.lessonsInTopic,
                note: saved.repeated
                  ? 'This lesson was already known; it was counted again. Tell the user it is noted.'
                  : saved.large
                    ? `Saved. The topic "${saved.topic}" is large: file the next lessons under a narrower topic. Tell the user in one sentence what you saved.`
                    : 'Saved as a draft the user will be asked to confirm. Tell the user in one sentence what you saved.',
              });
            } catch (err) {
              return failure(err);
            }
          },
        ),
    },
    {
      name: LEARNING_REVIEW_TOOL,
      sig: `${LEARNING_REVIEW_TOOL}:${base}`,
      register: (mcpServer: McpServer) =>
        mcpServer.registerTool(
          LEARNING_REVIEW_TOOL,
          {
            description:
              `Lists the lessons of learning project "${name}" the user has not confirmed yet. Use it when the ` +
              'user asks what you have learned, or at the start of a conversation to check whether lessons wait ' +
              `for them. Read each lesson to the user and ask whether it is right, then call ${LEARNING_CONFIRM_TOOL}.`,
            inputSchema: {
              topic: z.string().max(LEARNING_LIMITS.title).optional().describe('Only the lessons of this topic.'),
              limit: z.number().int().min(1).max(LEARNING_LIMITS.review).optional().describe(`Default ${LEARNING_LIMITS.review}.`),
            },
            annotations: { title: 'Lessons to confirm', readOnlyHint: true, openWorldHint: false },
          },
          async (args: any) => {
            try {
              const now = await current();
              if (!now) return failure(new Error(ENDED));
              const res = await svc.review(now, args ?? {});
              return ok({
                ...res,
                next: res.lessons.length
                  ? 'Read these to the user and ask whether each is right. Where askWhy is true, the change was ' +
                    `seen in their work but not explained: ask why. Then call ${LEARNING_CONFIRM_TOOL} with their answers.`
                  : 'Nothing waits for confirmation.',
              });
            } catch (err) {
              return failure(err);
            }
          },
        ),
    },
    {
      name: LEARNING_CONFIRM_TOOL,
      sig: `${LEARNING_CONFIRM_TOOL}:${base}`,
      register: (mcpServer: McpServer) =>
        mcpServer.registerTool(
          LEARNING_CONFIRM_TOOL,
          {
            description:
              `Records the user's answers on lessons from ${LEARNING_REVIEW_TOOL}: confirm (it is right), reject ` +
              '(it is wrong or not worth keeping) or correct (right, but in the words given as "text"). Only ' +
              'pass what the user actually said; never confirm on their behalf.',
            inputSchema: {
              decisions: z
                .array(
                  z.object({
                    id: z.string().max(64).describe('The lesson id.'),
                    verdict: z.enum(['confirm', 'reject', 'correct']),
                    text: z.string().max(LEARNING_LIMITS.text).optional().describe('For correct: the lesson as the user wants it.'),
                    reason: z.string().max(LEARNING_LIMITS.detail).optional().describe("The user's reason, when they gave one."),
                  }),
                )
                .min(1)
                .max(LEARNING_LIMITS.decisions),
            },
            annotations: {
              title: 'Confirm lessons',
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (args: any) => {
            try {
              const now = await current();
              if (!now) return failure(new Error(ENDED));
              return ok(await svc.confirm(now, args?.decisions ?? [], now.userId));
            } catch (err) {
              return failure(err);
            }
          },
        ),
    },
  ];
}
