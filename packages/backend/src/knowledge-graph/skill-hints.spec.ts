import { SKILL_HINTS_LISTED, skillHintText, type SkillHint } from './skill-hints';

const TOOLS = { list: 'skills_list', get: 'skill_get' };

function hint(over: Partial<SkillHint> = {}): SkillHint {
  return {
    id: 's1',
    title: 'German address check',
    whenToUse: 'When the user asks to check a German address',
    instruction: 'Validate German addresses with OpenPLZ.',
    hasBody: true,
    connectorId: null,
    ...over,
  };
}

describe('skillHintText', () => {
  it('names a server-wide skill on every tool, with the skill_get pointer', () => {
    const text = skillHintText([hint()], 'c-any', TOOLS);
    expect(text).toContain('Workspace skills for this tool');
    expect(text).toContain('- German address check (when: When the user asks to check a German address)');
    expect(text).toContain('Validate German addresses with OpenPLZ.');
    expect(text).toContain('Read the full procedure first with skill_get "s1".');
  });

  it('names a connector skill only on that connector\'s tools', () => {
    const hints = [hint({ connectorId: 'c1' })];
    expect(skillHintText(hints, 'c1', TOOLS)).toContain('German address check');
    expect(skillHintText(hints, 'c2', TOOLS)).toBe('');
  });

  it('leaves the skill_get pointer out when a skill has no procedure', () => {
    const text = skillHintText([hint({ hasBody: false })], 'c1', TOOLS);
    expect(text).not.toContain('skill_get');
  });

  it('points to skills_list instead of listing many skills', () => {
    const hints = Array.from({ length: SKILL_HINTS_LISTED + 2 }, (_, i) =>
      hint({ id: `s${i}`, title: `Skill ${i}` }),
    );
    const text = skillHintText(hints, 'c1', TOOLS);
    expect(text).toContain(`This workspace has ${SKILL_HINTS_LISTED + 2} skills`);
    expect(text).toContain('call skills_list');
    expect(text).not.toContain('Skill 0');
  });

  it('keeps each line short whatever the skill text', () => {
    const long = 'x'.repeat(5000);
    const text = skillHintText(
      [hint({ title: long, whenToUse: long, instruction: long })],
      'c1',
      TOOLS,
    );
    expect(text.length).toBeLessThan(600);
  });

  it('returns nothing without skills', () => {
    expect(skillHintText([], 'c1', TOOLS)).toBe('');
  });
});
