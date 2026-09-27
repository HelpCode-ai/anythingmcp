import { renderStaticResponse } from './static-response.util';

describe('renderStaticResponse', () => {
  it('returns a plain static response whatever the arguments', () => {
    expect(renderStaticResponse({ staticResponse: 'hello' }, { topic: 'x' })).toBe('hello');
  });

  it('throws a readable error when there is nothing to return', () => {
    expect(() => renderStaticResponse({}, {})).toThrow(/fixed text response/);
  });

  const guide = {
    staticResponse: 'SAP guide.',
    staticResponses: { basics: 'MANDT is the client.', Finance: 'Use ACDOCA.', empty: '  ' },
  };

  it('picks a topic case-insensitively', () => {
    expect(renderStaticResponse(guide, { topic: 'finance' })).toBe('Use ACDOCA.');
    expect(renderStaticResponse(guide, { topic: ' BASICS ' })).toBe('MANDT is the client.');
  });

  it('answers with the overview and the topic list when no topic is given', () => {
    expect(renderStaticResponse(guide, {})).toBe(
      'SAP guide.\n\nTopics (pass one as "topic"): basics, Finance',
    );
  });

  it('names the wrong topic and lists the right ones', () => {
    const out = renderStaticResponse(guide, { topic: 'hr' });
    expect(out).toMatch(/^There is no topic "hr"\./);
    expect(out).toMatch(/basics, Finance$/);
  });

  it('honours a custom topic parameter', () => {
    expect(
      renderStaticResponse(
        { staticResponses: { a: 'A' }, topicParam: 'section' },
        { section: 'a' },
      ),
    ).toBe('A');
  });
});
