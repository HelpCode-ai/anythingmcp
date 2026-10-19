import { diffArgs, findFixPatterns, shapeOf } from './error-fix';
import { errorFixSkill } from './kg-skill.service';

const t0 = new Date('2026-10-19T10:00:00Z').getTime();
const at = (min: number) => new Date(t0 + min * 60_000);
const call = (userId: string | null, status: string, input: unknown, min: number, toolId = 'tool-1', error: string | null = null) => ({
  toolId,
  userId,
  status,
  input,
  error,
  createdAt: at(min),
});

describe('shapeOf', () => {
  it('keeps the format and drops the value', () => {
    expect(shapeOf('12.10.2026')).toBe('"99.99.9999"');
    expect(shapeOf('2026-10-12')).toBe('"9999-99-99"');
    expect(shapeOf('Müller')).toBe('"aaaaaa"');
    expect(shapeOf('x'.repeat(40))).toBe('text(40 chars)');
    expect(shapeOf(42)).toBe('integer');
    expect(shapeOf(undefined)).toBe('missing');
    expect(shapeOf([1, 2])).toBe('list(integer)');
  });
});

describe('diffArgs', () => {
  it('reports arguments whose format changed, never values, and ignores _ params', () => {
    expect(
      diffArgs({ date: '12.10.2026', customer: 'Anna', _intent: 'x' }, { date: '2026-10-12', customer: 'Bert' }),
    ).toEqual([{ key: 'date', before: '"99.99.9999"', after: '"9999-99-99"' }]);
    expect(diffArgs({ q: 'a' }, { q: 'a', limit: 10 })).toEqual([{ key: 'limit', before: 'missing', after: 'integer' }]);
  });
});

describe('findFixPatterns', () => {
  const fixed = (user: string, start: number) => [
    call(user, 'ERROR', { date: '12.10.2026' }, start, 'tool-1', 'Invalid date 12.10.2026'),
    call(user, 'SUCCESS', { date: '2026-10-12' }, start + 2),
  ];

  it('finds a failure fixed by a format change, counted per occurrence and person', () => {
    const rows = [...fixed('u1', 0), ...fixed('u1', 30), ...fixed('u2', 5)].sort(
      (a, b) => a.userId!.localeCompare(b.userId!) || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const [p] = findFixPatterns(rows);
    expect(p).toEqual(
      expect.objectContaining({
        toolId: 'tool-1',
        occurrences: 3,
        users: 2,
        changes: [{ key: 'date', before: '"99.99.9999"', after: '"9999-99-99"' }],
      }),
    );
  });

  it('ignores single occurrences, slow fixes, other people, retries and value-only fixes', () => {
    expect(findFixPatterns(fixed('u1', 0))).toEqual([]);
    const slow = [call('u1', 'ERROR', { date: '12.10.2026' }, 0), call('u1', 'SUCCESS', { date: '2026-10-12' }, 30)];
    expect(findFixPatterns([...slow, ...slow.map((r) => ({ ...r, createdAt: new Date(r.createdAt.getTime() + 3_600_000) }))])).toEqual([]);
    const retry = [call('u1', 'ERROR', { id: 'A1' }, 0), call('u1', 'SUCCESS', { id: 'A1' }, 1)];
    expect(findFixPatterns([...retry, ...retry])).toEqual([]);
    const valueOnly = [call('u1', 'ERROR', { id: 'A1' }, 0), call('u1', 'SUCCESS', { id: 'B2' }, 1)];
    expect(findFixPatterns([...valueOnly, ...valueOnly])).toEqual([]);
    const anonymous = [call(null, 'ERROR', { date: '12.10.2026' }, 0), call(null, 'SUCCESS', { date: '2026-10-12' }, 1)];
    expect(findFixPatterns([...anonymous, ...anonymous])).toEqual([]);
  });
});

describe('errorFixSkill', () => {
  it('writes the rule with names and formats and masks the error', () => {
    const skill = errorFixSkill('erp_create_order', {
      toolId: 't',
      signature: 's',
      changes: [{ key: 'date', before: '"99.99.9999"', after: '"9999-99-99"' }],
      occurrences: 3,
      users: 2,
      error: 'Invalid date 12.10.2026 for anna@example.com',
    });
    expect(skill.title).toBe('erp_create_order: `date` as "9999-99-99"');
    expect(skill.instruction).toContain('Send `date` as "9999-99-99"');
    expect(skill.instruction).toContain('failed ("Invalid date ');
    expect(skill.instruction).not.toContain('anna@example.com');
    expect(skill.instruction).not.toContain('12.10.2026');
    expect(skill.instruction).toContain('3 times, 2 people');
  });
});
