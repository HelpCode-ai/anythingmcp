import type { MessageStructureObject } from 'imapflow';
import {
  MAX_SEARCH_LIMIT,
  analyseStructure,
  buildSearchQuery,
  clampInt,
  isTextualType,
  parseUids,
  replyReferences,
  replySubject,
  snippetOf,
  truncateText,
} from './email-message.util';
import { EmailConnectorError } from './email-settings';

describe('buildSearchQuery', () => {
  it('maps every criterion onto the imapflow query', () => {
    const q = buildSearchQuery({
      from: 'bob@example.org',
      to: 'anna',
      subject: 'Invoice',
      text: 'order 4711',
      since: '2026-10-01',
      before: '2026-10-15',
      unread_only: true,
      flagged_only: true,
    });
    expect(q).toEqual({
      from: 'bob@example.org',
      to: 'anna',
      subject: 'Invoice',
      text: 'order 4711',
      since: new Date(Date.UTC(2026, 9, 1)),
      before: new Date(Date.UTC(2026, 9, 15)),
      seen: false,
      flagged: true,
    });
  });

  it('lists everything when no criterion is given', () => {
    expect(buildSearchQuery({})).toEqual({ all: true });
    expect(buildSearchQuery({ unread_only: false, from: '' })).toEqual({ all: true });
  });

  it('takes the date part of an ISO timestamp', () => {
    expect(buildSearchQuery({ since: '2026-10-01T13:00:00Z' }).since).toEqual(new Date(Date.UTC(2026, 9, 1)));
  });

  it('refuses impossible dates, inverted ranges and multi-line criteria', () => {
    expect(() => buildSearchQuery({ since: '2026-02-30' })).toThrow(/YYYY-MM-DD/);
    expect(() => buildSearchQuery({ since: 'yesterday' })).toThrow(EmailConnectorError);
    expect(() => buildSearchQuery({ since: '2026-10-15', before: '2026-10-01' })).toThrow(/earlier/);
    expect(() => buildSearchQuery({ subject: 'a\r\nb' })).toThrow(/single line/);
    expect(() => buildSearchQuery({ text: 'x'.repeat(501) })).toThrow(/longer/);
  });
});

describe('limits and UIDs', () => {
  it('clamps the search limit to the hard cap', () => {
    expect(clampInt(undefined, 20, MAX_SEARCH_LIMIT)).toBe(20);
    expect(clampInt(5000, 20, MAX_SEARCH_LIMIT)).toBe(MAX_SEARCH_LIMIT);
    expect(clampInt('7', 20, MAX_SEARCH_LIMIT)).toBe(7);
    expect(clampInt(0, 20, MAX_SEARCH_LIMIT)).toBe(1);
    expect(clampInt('many', 20, MAX_SEARCH_LIMIT)).toBe(20);
  });

  it('accepts UIDs as an array, a number or a comma list, deduplicated', () => {
    expect(parseUids([3, '4', 3])).toEqual([3, 4]);
    expect(parseUids(9)).toEqual([9]);
    expect(parseUids('1, 2 5')).toEqual([1, 2, 5]);
  });

  it('refuses empty, non-numeric and oversized UID lists', () => {
    expect(() => parseUids([])).toThrow(/at least one/);
    expect(() => parseUids(['1:*'])).toThrow(/UID/);
    expect(() => parseUids([0])).toThrow(/UID/);
    expect(() => parseUids(Array.from({ length: 101 }, (_, i) => i + 1))).toThrow(/At most 100/);
  });
});

describe('analyseStructure', () => {
  const mixed: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain', size: 120, encoding: 'quoted-printable' },
          { part: '1.2', type: 'text/html', size: 400, encoding: 'quoted-printable' },
        ],
      },
      {
        part: '2',
        type: 'application/pdf',
        size: 4000,
        encoding: 'base64',
        disposition: 'attachment',
        dispositionParameters: { filename: 'Rechnung 4711.pdf' },
      },
      { part: '3', type: 'image/png', size: 800, encoding: 'base64', disposition: 'inline', id: '<logo@x>', parameters: { name: 'logo.png' } },
      { part: '4', type: 'message/rfc822', size: 2000, encoding: '7bit' },
      { part: '5', type: 'text/csv', size: 50, disposition: 'attachment', dispositionParameters: { filename: '../../etc/export.csv' } },
    ],
  };

  it('finds the text and HTML bodies and numbers the attachments', () => {
    const parts = analyseStructure(mixed);
    expect(parts.text).toEqual({ part: '1.1', type: 'text/plain', size: 120 });
    expect(parts.html).toEqual({ part: '1.2', type: 'text/html', size: 400 });
    expect(parts.attachments.map((a) => [a.index, a.part, a.filename, a.contentType, a.inline])).toEqual([
      [1, '2', 'Rechnung 4711.pdf', 'application/pdf', false],
      [2, '3', 'logo.png', 'image/png', true],
      [3, '4', 'part-4.eml', 'message/rfc822', false],
      // A path in a file name is dropped.
      [4, '5', 'export.csv', 'text/csv', false],
    ]);
    // Base64 size is the encoded size; the decoded estimate is smaller.
    expect(parts.attachments[0].approxBytes).toBeLessThan(4000);
    expect(parts.attachments[0].approxBytes).toBeGreaterThan(2900);
  });

  it('reads a single-part message as body part 1', () => {
    expect(analyseStructure({ type: 'text/plain', size: 10 }).text?.part).toBe('1');
    expect(analyseStructure({ type: 'text/html', size: 10 }).html?.part).toBe('1');
    expect(analyseStructure(undefined)).toEqual({ attachments: [] });
  });

  it('treats a text part with attachment disposition as an attachment', () => {
    const parts = analyseStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 5 },
        { part: '2', type: 'text/plain', size: 5, disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } },
      ],
    });
    expect(parts.text?.part).toBe('1');
    expect(parts.attachments).toHaveLength(1);
    expect(parts.attachments[0].filename).toBe('notes.txt');
  });
});

describe('text helpers', () => {
  it('truncates with a marker that says how to read more', () => {
    const out = truncateText('a'.repeat(50), 20);
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(50);
    expect(out.text.startsWith('a'.repeat(20))).toBe(true);
    expect(out.text).toMatch(/truncated: showing 20 of 50 characters/);
    expect(out.text).toMatch(/max_chars/);
    expect(truncateText('short', 20)).toEqual({ text: 'short', truncated: false, totalChars: 5 });
  });

  it('collapses whitespace in a snippet and caps it', () => {
    expect(snippetOf('  Hello\n\n  world  ')).toBe('Hello world');
    expect(snippetOf('x'.repeat(300))).toHaveLength(201);
  });

  it('knows which attachments are text', () => {
    expect(isTextualType('text/csv')).toBe(true);
    expect(isTextualType('application/json')).toBe(true);
    expect(isTextualType('application/vnd.api+json')).toBe(true);
    expect(isTextualType('application/pdf')).toBe(false);
    expect(isTextualType('image/png')).toBe(false);
  });
});

describe('reply headers', () => {
  it('adds "Re:" once, also after a German or Nordic prefix', () => {
    expect(replySubject('Angebot')).toBe('Re: Angebot');
    expect(replySubject('Re: Angebot')).toBe('Re: Angebot');
    expect(replySubject('AW: Angebot')).toBe('AW: Angebot');
    expect(replySubject('SV:Tilbud')).toBe('SV:Tilbud');
    expect(replySubject(undefined)).toBe('Re:');
  });

  it("builds References from the parent's References and Message-ID", () => {
    expect(replyReferences(['<a@x>', '<b@x>'], '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(replyReferences('<a@x> <b@x>', '<b@x>')).toEqual(['<a@x>', '<b@x>']);
    expect(replyReferences(undefined, '<c@x>')).toEqual(['<c@x>']);
    const long = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`);
    const refs = replyReferences(long, '<last@x>');
    expect(refs).toHaveLength(20);
    expect(refs[0]).toBe('<m0@x>');
    expect(refs[19]).toBe('<last@x>');
  });
});
