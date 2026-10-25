/**
 * Skill hints in tool descriptions.
 *
 * Some clients never show a server's instructions to the model (claude.ai
 * keeps them out of the context and loads tool schemas on demand), so skills
 * delivered only as instructions are never seen there. A tool's description
 * is read right before the tool is called, in every client, so the skills
 * that cover a tool are also named in its description.
 */

/** A visible, applied skill reduced to what a hint needs. */
export interface SkillHint {
  id: string;
  title: string;
  whenToUse: string;
  instruction: string;
  hasBody: boolean;
  /** null: a server-wide skill, it covers every tool of the server. */
  connectorId: string | null;
}

/** Up to this many skills are spelled out; more become a pointer to skills_list. */
export const SKILL_HINTS_LISTED = 3;

function oneLine(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The text appended to the description of a tool of `connectorId`, or '' when
 * no skill covers it. Bounded: a few short lines per tool, whatever the number
 * of skills.
 */
export function skillHintText(
  hints: SkillHint[],
  connectorId: string,
  tools: { list: string; get: string },
): string {
  const relevant = hints.filter((h) => !h.connectorId || h.connectorId === connectorId);
  if (!relevant.length) return '';
  if (relevant.length > SKILL_HINTS_LISTED) {
    return (
      `\n\nThis workspace has ${relevant.length} skills (procedures and rules set by its admins) ` +
      `for tasks with this tool. Before using it for a recurring task, call ${tools.list} with a ` +
      `few words about the task and follow the skill that fits (${tools.get} returns it in full).`
    );
  }
  const lines = relevant.map((h) => {
    const when = h.whenToUse ? ` (when: ${oneLine(h.whenToUse, 120)})` : '';
    const rule = h.instruction ? `: ${oneLine(h.instruction, 160)}` : '';
    const open = h.hasBody ? ` Read the full procedure first with ${tools.get} "${h.id}".` : '';
    return `- ${oneLine(h.title, 80)}${when}${rule}${open}`;
  });
  return (
    '\n\nWorkspace skills for this tool (set by its admins; follow the one that fits the task):\n' +
    lines.join('\n')
  );
}
