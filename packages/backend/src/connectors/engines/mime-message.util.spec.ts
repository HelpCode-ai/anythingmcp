import {
  buildMimeMessage,
  containsMimeMarker,
  encodeMimeOutput,
  encodeWords,
  expandMimeMarkers,
  MimeBuildError,
} from './mime-message.util';

/* ------------------------------------------------------------------ */
/*  A small independent reader, so the tests do not trust the builder  */
/* ------------------------------------------------------------------ */

interface Parsed {
  headers: Array<[string, string]>;
  rawHeaderLines: string[];
  body: string;
}

function parse(message: string): Parsed {
  const split = message.indexOf('\r\n\r\n');
  expect(split).toBeGreaterThan(0);
  const head = message.slice(0, split);
  const body = message.slice(split + 4);
  const rawHeaderLines = head.split('\r\n');
  // Unfold: CRLF followed by whitespace continues the previous line.
  const unfolded = head.replace(/\r\n(?=[ \t])/g, '');
  const headers = unfolded.split('\r\n').map((line): [string, string] => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  });
  return { headers, rawHeaderLines, body };
}

function header(p: Parsed, name: string): string | undefined {
  return p.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
}

/** RFC 2047 decoding, B encoding only (all the builder emits). */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_m, b64: string) =>
      Buffer.from(b64, 'base64').toString('utf8'),
    );
}

function decodeBody(body: string): string {
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

const build = (spec: Record<string, unknown>) => buildMimeMessage(spec, { boundary: 'BOUNDARY' });

describe('buildMimeMessage', () => {
  it('builds a plain ASCII message with CRLF line endings and MIME headers', () => {
    const msg = build({ to: 'ana@example.com', subject: 'Hello', text: 'Line 1\nLine 2' });
    expect(msg).toBe(
      [
        'To: ana@example.com',
        'Subject: Hello',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Line 1\r\nLine 2').toString('base64'),
        '',
      ].join('\r\n'),
    );
    // No bare LF anywhere.
    expect(msg.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['German umlauts and ß', 'Grüße aus Freiburg: Straße, Öl, Ärger'],
    ['Italian accents', 'Perché è già così: città, più, però'],
    ['emoji', 'Launch 🚀 done ✅ 👨‍👩‍👧'],
    ['Japanese', '会議の議事録をお送りします'],
  ])('encodes a %s subject as RFC 2047 UTF-8 B words that decode back', (_label, subject) => {
    const msg = build({ to: 'a@example.com', subject, text: subject });
    const p = parse(msg);
    const raw = header(p, 'Subject')!;
    expect(raw).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(raw)).toBe(subject);
    expect(decodeBody(p.body)).toBe(subject);
    // Header lines are pure ASCII.
    for (const line of p.rawHeaderLines) expect(line).toMatch(/^[\x20-\x7E]*$/);
  });

  it('folds a long non-ASCII subject into words of at most 75 characters on lines of at most 76', () => {
    const subject = 'Überprüfung der Rechnungsnummer für die Bestellung über Ölheizungsersatzteile — ' .repeat(4);
    const msg = build({ to: 'a@example.com', subject: subject.trim() });
    const p = parse(msg);
    const subjectLines = p.rawHeaderLines.slice(
      p.rawHeaderLines.findIndex((l) => l.startsWith('Subject:')),
    );
    const end = subjectLines.findIndex((l, i) => i > 0 && !l.startsWith(' '));
    const lines = subjectLines.slice(0, end);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    for (const word of header(p, 'Subject')!.match(/=\?[^?]+\?B\?[^?]*\?=/g)!) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeWords(header(p, 'Subject')!)).toBe(subject.trim());
  });

  it('never splits a multi-byte character across encoded words', () => {
    const words = encodeWords('🚀'.repeat(40));
    for (const w of words) {
      const bytes = Buffer.from(w.slice(10, -2), 'base64');
      expect(bytes.length % 4).toBe(0);
      expect(bytes.toString('utf8')).toMatch(/^(🚀)+$/);
    }
  });

  it('folds a long ASCII subject at spaces and unfolds to the original', () => {
    const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const p = parse(build({ to: 'a@example.com', subject }));
    expect(header(p, 'Subject')).toBe(subject);
    for (const line of p.rawHeaderLines) expect(line.length).toBeLessThanOrEqual(78);
  });

  it('encodes an ASCII subject that looks like an encoded word', () => {
    const p = parse(build({ subject: 'see =?UTF-8?B?abc?= here' }));
    expect(header(p, 'Subject')).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(header(p, 'Subject')!)).toBe('see =?UTF-8?B?abc?= here');
  });

  it('handles several recipients as a list or a comma-separated string, with non-ASCII display names', () => {
    const msg = build({
      to: ['Jürgen Müller <juergen@example.de>', 'ana@example.com'],
      cc: 'Niccolò Rossi <n.rossi@example.it>, "Doe, John" <john@example.com>; 山田太郎 <yamada@example.jp>',
      bcc: ['hidden@example.com'],
      subject: 'x',
    });
    const p = parse(msg);
    const to = header(p, 'To')!;
    expect(decodeWords(to)).toBe('Jürgen Müller <juergen@example.de>, ana@example.com');
    const cc = header(p, 'Cc')!;
    expect(decodeWords(cc)).toBe(
      'Niccolò Rossi <n.rossi@example.it>, "Doe, John" <john@example.com>, 山田太郎 <yamada@example.jp>',
    );
    expect(header(p, 'Bcc')).toBe('hidden@example.com');
    for (const line of p.rawHeaderLines) {
      expect(line).toMatch(/^[\x20-\x7E]*$/);
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('quotes an ASCII display name with specials', () => {
    const p = parse(build({ to: 'J. Smith (Sales) <j@example.com>' }));
    expect(header(p, 'To')).toBe('"J. Smith (Sales)" <j@example.com>');
  });

  it.each([
    ['subject', { subject: 'Hi\r\nBcc: victim@example.com' }],
    ['subject', { subject: 'Hi\nX-Injected: 1' }],
    ['subject', { subject: 'Hi\rthere' }],
    ['to', { to: 'a@example.com\r\nBcc: victim@example.com' }],
    ['to', { to: ['ok@example.com', 'Name\n <b@example.com>'] }],
    ['cc', { cc: 'x@example.com\nSubject: spoof' }],
    ['inReplyTo', { inReplyTo: '<a@b>\r\nBcc: v@example.com' }],
    ['references', { references: '<a@b>\n<c@d>' }],
    ['subject', { subject: 'nul\u0000byte' }],
  ])('rejects a line break or control character in %s', (field, spec) => {
    expect(() => build(spec)).toThrow(MimeBuildError);
    expect(() => build(spec)).toThrow(new RegExp(`^${field}`));
  });

  it.each(['not-an-address', 'a@b@c', 'two words@example.com', '<>', 'Name <bad>'])(
    'rejects %p as an address',
    (to) => {
      expect(() => build({ to })).toThrow(/is not an e-mail address/);
    },
  );

  it('rejects unknown fields so a typo in an adapter is not silently dropped', () => {
    expect(() => build({ To: 'a@example.com' })).toThrow(/unknown field "To"/);
  });

  it('builds multipart/alternative when html is given, both parts base64 UTF-8', () => {
    const msg = build({ to: 'a@example.com', subject: 'x', text: 'Grüße', html: '<p>Grüße</p>' });
    const p = parse(msg);
    expect(header(p, 'Content-Type')).toBe('multipart/alternative; boundary="BOUNDARY"');
    expect(header(p, 'Content-Transfer-Encoding')).toBeUndefined();
    const parts = p.body.split('--BOUNDARY');
    expect(parts[0]).toBe('');
    expect(parts[3]).toBe('--\r\n');
    const plain = parse(parts[1].replace(/^\r\n/, ''));
    const html = parse(parts[2].replace(/^\r\n/, ''));
    expect(header(plain, 'Content-Type')).toBe('text/plain; charset=UTF-8');
    expect(header(html, 'Content-Type')).toBe('text/html; charset=UTF-8');
    expect(decodeBody(plain.body)).toBe('Grüße');
    expect(decodeBody(html.body)).toBe('<p>Grüße</p>');
  });

  it('uses a random boundary by default', () => {
    const a = buildMimeMessage({ text: 'a', html: '<b>a</b>' });
    const b = buildMimeMessage({ text: 'a', html: '<b>a</b>' });
    const boundary = (m: string) => /boundary="([^"]+)"/.exec(m)![1];
    expect(boundary(a)).not.toBe(boundary(b));
    expect(boundary(a)).toMatch(/^amcp_[0-9a-f]{24}$/);
  });

  it('sends an html-only message as text/html', () => {
    const p = parse(build({ html: '<b>x</b>' }));
    expect(header(p, 'Content-Type')).toBe('text/html; charset=UTF-8');
  });

  it('wraps base64 body lines at 76 characters', () => {
    const p = parse(build({ text: 'ä'.repeat(500) }));
    const lines = p.body.split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
  });

  it('sets In-Reply-To and References for a reply, appending the parent id to References', () => {
    const p = parse(
      build({
        inReplyTo: '<parent@mail.gmail.com>',
        references: '<root@mail.gmail.com> <mid@mail.gmail.com>',
        subject: 'Offer',
        subjectPrefix: 'Re: ',
      }),
    );
    expect(header(p, 'In-Reply-To')).toBe('<parent@mail.gmail.com>');
    expect(header(p, 'References')).toBe('<root@mail.gmail.com> <mid@mail.gmail.com> <parent@mail.gmail.com>');
    expect(header(p, 'Subject')).toBe('Re: Offer');
  });

  it('adds angle brackets to a bare Message-ID and uses it as References when none is given', () => {
    const p = parse(build({ inReplyTo: 'parent@mail.gmail.com' }));
    expect(header(p, 'In-Reply-To')).toBe('<parent@mail.gmail.com>');
    expect(header(p, 'References')).toBe('<parent@mail.gmail.com>');
  });

  it('does not double a reply prefix', () => {
    expect(header(parse(build({ subject: 'RE: Offer', subjectPrefix: 'Re: ' })), 'Subject')).toBe('RE: Offer');
    expect(header(parse(build({ subject: 'Offerta', subjectPrefix: 'Re: ' })), 'Subject')).toBe('Re: Offerta');
  });

  it('round-trips through base64url: the encoded output decodes to the same valid message', () => {
    const msg = build({
      to: ['Zoë Ångström <zoe@example.com>'],
      subject: 'Ciao 👋 Grüße 日本',
      text: 'Ciao!\nÈ tutto ok?\n',
      html: '<p>Ciao!</p>',
    });
    const encoded = encodeMimeOutput(msg);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(decoded).toBe(msg);
    const p = parse(decoded);
    expect(header(p, 'MIME-Version')).toBe('1.0');
    expect(decodeWords(header(p, 'Subject')!)).toBe('Ciao 👋 Grüße 日本');
    expect(decodeWords(header(p, 'To')!)).toBe('Zoë Ångström <zoe@example.com>');
    expect(encodeMimeOutput(msg, 'base64')).toBe(Buffer.from(msg).toString('base64'));
    expect(encodeMimeOutput(msg, 'none')).toBe(msg);
  });
});

describe('expandMimeMarkers', () => {
  const resolve = (params: Record<string, unknown>) => (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$')) return params[v.slice(1)];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .map(([k, x]) => [k, resolve(params)(x)])
          .filter(([, x]) => x !== undefined),
      );
    }
    return v;
  };

  it('finds markers at any depth and only there', () => {
    expect(containsMimeMarker({ a: 1, b: ['$x'] })).toBe(false);
    expect(containsMimeMarker({ message: { raw: { __mime: {} } } })).toBe(true);
    expect(containsMimeMarker([{ __mime: {} }])).toBe(true);
  });

  it('replaces a marker with a $reference to the encoded message', () => {
    const { template, values } = expandMimeMarkers(
      { message: { raw: { __mime: { to: '$to', text: '$body' } }, threadId: '$t' } },
      resolve({ to: 'a@example.com', body: 'hi' }),
    );
    expect(template).toEqual({ message: { raw: '$__amcp_mime_0', threadId: '$t' } });
    const decoded = Buffer.from(values.__amcp_mime_0, 'base64url').toString('utf8');
    expect(decoded.startsWith('To: a@example.com\r\n')).toBe(true);
  });

  it('honours __encoding and rejects unknown marker keys or encodings', () => {
    const r = resolve({});
    expect(expandMimeMarkers({ raw: { __mime: { text: 'x' }, __encoding: 'none' } }, r).values.__amcp_mime_0).toMatch(
      /^MIME-Version: 1.0\r\n/,
    );
    expect(() => expandMimeMarkers({ raw: { __mime: {}, extra: 1 } }, r)).toThrow(/only "__mime" and "__encoding"/);
    expect(() => expandMimeMarkers({ raw: { __mime: {}, __encoding: 'hex' } }, r)).toThrow(/__encoding must be/);
    expect(() => expandMimeMarkers({ raw: { __mime: '$x' } }, r)).toThrow(/__mime must be an object/);
  });
});
