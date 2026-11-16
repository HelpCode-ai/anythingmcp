import { LEARNED_INSTRUCTION_MAX, lessonDetail, lessonsFor, renderLearnedSkill } from './learning-render';

let seq = 0;
const lesson = (kind: string, text: string, extra: Partial<any> = {}) => ({
  id: `l${++seq}`,
  kind,
  text,
  status: 'confirmed',
  detail: {},
  createdAt: new Date(2026, 0, 1, 0, 0, seq),
  ...extra,
});

describe('renderLearnedSkill', () => {
  beforeEach(() => (seq = 0));
  const topic = { title: 'Old window hardware' };

  it('returns nothing without lessons', () => {
    expect(renderLearnedSkill(topic, [], 'draft')).toEqual({ instruction: '', body: null, included: 0, dropped: 0 });
  });

  it('files each kind under its heading, in a fixed order', () => {
    const out = renderLearnedSkill(
      topic,
      [
        lesson('example', 'Quote 4711: two hinges and one handle'),
        lesson('fact', 'Series 300 uses the 12 mm groove'),
        lesson('correction', 'Take hinge BR-12103', { detail: { before: 'hinge BR-99', after: 'hinge BR-12103', reason: 'BR-99 is discontinued' } }),
        lesson('rule', 'Always check the groove width first'),
      ],
      'published',
    );
    expect(out.body).toBe(
      [
        '## Rules\n- Always check the groove width first',
        '## Corrections\n- Take hinge BR-12103\n  Instead of: hinge BR-99. Use: hinge BR-12103.\n  Why: BR-99 is discontinued.',
        '## Facts\n- Series 300 uses the 12 mm groove',
        '## Examples\n- Quote 4711: two hinges and one handle',
      ].join('\n\n'),
    );
    expect(out.included).toBe(4);
    expect(out.dropped).toBe(0);
  });

  it('puts rules and corrections first in the short version, as sentences', () => {
    const out = renderLearnedSkill(
      topic,
      [lesson('fact', 'Series 300 uses the 12 mm groove'), lesson('rule', 'Check the groove width first')],
      'published',
    );
    expect(out.instruction).toBe('Check the groove width first. Series 300 uses the 12 mm groove.');
  });

  it('keeps the short version within its limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => lesson('rule', `Rule number ${i} says something about hardware`));
    const out = renderLearnedSkill(topic, many, 'published');
    expect(out.instruction.length).toBeLessThanOrEqual(LEARNED_INSTRUCTION_MAX);
    expect(out.instruction.startsWith('Rule number 0')).toBe(true);
    // The full text still holds all of them.
    expect(out.included).toBe(30);
  });

  it('shows the expert unconfirmed lessons, and everyone else only confirmed ones', () => {
    const lessons = [
      lesson('rule', 'Draft rule', { status: 'draft' }),
      lesson('rule', 'Confirmed rule'),
      lesson('rule', 'Rejected rule', { status: 'rejected' }),
      lesson('rule', 'Old rule', { status: 'superseded' }),
    ];
    const draft = renderLearnedSkill(topic, lessons, 'draft');
    expect(draft.body).toBe('## Rules\n- Confirmed rule\n- Draft rule');
    const published = renderLearnedSkill(topic, lessons, 'published');
    expect(published.body).toBe('## Rules\n- Confirmed rule');
    expect(published.body).not.toContain('Draft rule');
  });

  it('publishes nothing while nothing is confirmed', () => {
    expect(renderLearnedSkill(topic, [lesson('rule', 'Draft', { status: 'draft' })], 'published').body).toBeNull();
  });

  it('drops the oldest examples first when the text is too long, and says how many', () => {
    const lessons = [
      lesson('rule', 'The rule stays'),
      lesson('example', `Old example ${'x'.repeat(200)}`),
      lesson('example', `New example ${'y'.repeat(200)}`),
    ];
    const out = renderLearnedSkill(topic, lessons, 'published', 300);
    expect(out.body).toContain('The rule stays');
    expect(out.body).toContain('New example');
    expect(out.body).not.toContain('Old example');
    expect(out).toEqual(expect.objectContaining({ included: 2, dropped: 1 }));
  });

  it('never drops the last lesson: it is cut instead', () => {
    const out = renderLearnedSkill(topic, [lesson('rule', 'z'.repeat(500))], 'published', 100);
    expect(out.included).toBe(1);
    expect(out.body!.length).toBe(100);
  });

  it('is the same text for the same lessons, whatever their order', () => {
    const a = lesson('rule', 'First');
    const b = lesson('rule', 'Second');
    expect(renderLearnedSkill(topic, [a, b], 'published')).toEqual(renderLearnedSkill(topic, [b, a], 'published'));
  });

  it('indents a lesson of several lines under its bullet', () => {
    const out = renderLearnedSkill(topic, [lesson('example', 'Quote:\n2 x hinge\n1 x handle')], 'published');
    expect(out.body).toBe('## Examples\n- Quote:\n  2 x hinge\n  1 x handle');
  });
});

describe('lesson helpers', () => {
  it('reads only known text fields from a stored detail', () => {
    expect(lessonDetail({ before: ' a ', after: '', reason: 5, needsReason: true, other: 'x' })).toEqual({
      before: 'a',
      after: undefined,
      reason: undefined,
      tool: undefined,
      needsReason: true,
    });
    expect(lessonDetail(null)).toEqual({});
    expect(lessonDetail(['x'])).toEqual({});
  });

  it('orders confirmed lessons before drafts', () => {
    seq = 0;
    const d = lesson('rule', 'd', { status: 'draft' });
    const c = lesson('rule', 'c');
    expect(lessonsFor([d, c], 'draft').map((l) => l.text)).toEqual(['c', 'd']);
  });
});
