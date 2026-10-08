import {
  applyDecode,
  decodeBase64Url,
  decodeEncodedWords,
  htmlToText,
  readDecode,
  validateDecode,
} from './mime-decode.util';
import { applyResponseTransform, hasTransform } from './response-transform.util';

const b64url = (text: string, encoding: BufferEncoding = 'utf8') =>
  Buffer.from(text, encoding).toString('base64url');

const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

const config = readDecode({ decode: 'gmail-message' })!;

/** A Gmail `format=full` message: multipart/mixed > (alternative > plain, html), attachment. */
function nestedMessage() {
  return {
    id: '18c1',
    threadId: '18c0',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Grüße aus Freiburg',
    internalDate: '1759900000000',
    historyId: '42',
    sizeEstimate: 12345,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: headers({
        From: 'Jürgen Müller <juergen@example.de>',
        To: 'ana@example.com',
        Cc: 'team@example.com',
        Subject: 'Angebot für Öl — Grüße',
        Date: 'Wed, 8 Oct 2026 09:00:00 +0200',
        'Message-ID': '<CAF123@mail.gmail.com>',
        References: '<root@mail.gmail.com>',
        'In-Reply-To': '<root@mail.gmail.com>',
      }),
      body: { size: 0 },
      parts: [
        {
          partId: '0',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: headers({ 'Content-Type': 'multipart/alternative; boundary="x"' }),
          body: { size: 0 },
          parts: [
            {
              partId: '0.0',
              mimeType: 'text/plain',
              filename: '',
              headers: headers({ 'Content-Type': 'text/plain; charset="UTF-8"' }),
              body: { size: 30, data: b64url('Grüße aus Freiburg\r\nÄrger? Nein.') },
            },
            {
              partId: '0.1',
              mimeType: 'text/html',
              filename: '',
              headers: headers({ 'Content-Type': 'text/html; charset="UTF-8"' }),
              body: { size: 40, data: b64url('<p>Grüße aus <b>Freiburg</b></p>') },
            },
          ],
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'Angebot.pdf',
          headers: headers({ 'Content-Disposition': 'attachment; filename="Angebot.pdf"' }),
          body: { size: 52000, attachmentId: 'ANGjdJ9' },
        },
      ],
    },
  };
}

describe('decodeBase64Url', () => {
  it('decodes the URL-safe alphabet with and without padding', () => {
    const text = 'ü?>~ ÿ';
    const url = Buffer.from(text).toString('base64url');
    expect(url).toMatch(/[-_]/);
    expect(decodeBase64Url(url).toString('utf8')).toBe(text);
    expect(decodeBase64Url(Buffer.from(text).toString('base64')).toString('utf8')).toBe(text);
  });
});

describe('decodeEncodedWords', () => {
  it('decodes B and Q words and joins adjacent words', () => {
    expect(decodeEncodedWords('=?UTF-8?B?R3LDvMOfZQ==?= =?UTF-8?B?IGF1cw==?=')).toBe('Grüße aus');
    expect(decodeEncodedWords('=?ISO-8859-1?Q?Gr=FC=DFe_aus?= Freiburg')).toBe('Grüße aus Freiburg');
    expect(decodeEncodedWords('plain')).toBe('plain');
  });
});

describe('htmlToText', () => {
  it('drops tags, scripts and styles, keeps block breaks and decodes entities once', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      '<p>Hallo&nbsp;Ana,</p><div>Preis: 5 &euro; &amp;lt;b&amp;gt;</div><script>alert(1)</script>' +
      '<!-- comment --><ul><li>eins</li><li>zwei</li></ul>&#128640;&#x1F44B;</body></html>';
    expect(htmlToText(html)).toBe('Hallo Ana,\n\nPreis: 5 € &lt;b&gt;\neins\nzwei\n🚀👋');
  });

  it('copes with unterminated markup', () => {
    expect(htmlToText('text <b')).toBe('text');
    expect(htmlToText('a <script>never closed')).toBe('a');
  });
});

describe('applyDecode (gmail-message)', () => {
  it('decodes a nested multipart message: headers, text/plain preferred, attachments listed', () => {
    const out = applyDecode(nestedMessage(), config) as Record<string, unknown>;
    expect(out).toEqual({
      id: '18c1',
      threadId: '18c0',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Grüße aus Freiburg',
      internalDate: '1759900000000',
      historyId: '42',
      from: 'Jürgen Müller <juergen@example.de>',
      to: 'ana@example.com',
      cc: 'team@example.com',
      subject: 'Angebot für Öl — Grüße',
      date: 'Wed, 8 Oct 2026 09:00:00 +0200',
      messageId: '<CAF123@mail.gmail.com>',
      inReplyTo: '<root@mail.gmail.com>',
      references: '<root@mail.gmail.com>',
      textFormat: 'text/plain',
      text: 'Grüße aus Freiburg\nÄrger? Nein.',
      attachments: [
        { partId: '1', filename: 'Angebot.pdf', mimeType: 'application/pdf', size: 52000, attachmentId: 'ANGjdJ9' },
      ],
    });
  });

  it('falls back to the HTML part converted to text when there is no text/plain', () => {
    const msg = {
      id: 'm',
      payload: {
        mimeType: 'text/html',
        headers: headers({ Subject: 'Newsletter', 'Content-Type': 'text/html; charset=UTF-8' }),
        body: { data: b64url('<h1>Benvenuti</h1><p>Perché è così &amp; più</p>') },
      },
    };
    const out = applyDecode(msg, config) as Record<string, unknown>;
    expect(out.textFormat).toBe('text/html (converted to text)');
    expect(out.text).toBe('Benvenuti\n\nPerché è così & più');
  });

  it('honours the part charset', () => {
    const msg = {
      id: 'm',
      payload: {
        mimeType: 'text/plain',
        headers: headers({ 'Content-Type': 'text/plain; charset=ISO-8859-1' }),
        body: { data: b64url('Grüße', 'latin1') },
      },
    };
    expect((applyDecode(msg, config) as Record<string, unknown>).text).toBe('Grüße');
  });

  it('keeps headers and omits text when the body data is missing (format=metadata)', () => {
    const msg = {
      id: 'm',
      threadId: 't',
      snippet: 's',
      payload: { mimeType: 'multipart/alternative', headers: headers({ From: 'a@example.com', Subject: 'Hi' }) },
    };
    expect(applyDecode(msg, config)).toEqual({ id: 'm', threadId: 't', snippet: 's', from: 'a@example.com', subject: 'Hi' });
  });

  it('passes through responses without a message payload (lists, minimal, raw)', () => {
    const list = { messages: [{ id: '1', threadId: '1' }], resultSizeEstimate: 1 };
    expect(applyDecode(list, config)).toBe(list);
    const raw = { id: '1', raw: 'VG86IGFAYg' };
    expect(applyDecode(raw, config)).toBe(raw);
    expect(applyDecode('text', config)).toBe('text');
    expect(applyDecode(null, config)).toBe(null);
  });

  it('decodes every message of a thread and the message of a draft', () => {
    const thread = applyDecode({ id: 't', historyId: '9', messages: [nestedMessage(), nestedMessage()] }, config) as {
      id: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(thread.id).toBe('t');
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].text).toBe('Grüße aus Freiburg\nÄrger? Nein.');
    expect(thread.messages[1]).not.toHaveProperty('payload');

    const draft = applyDecode({ id: 'r-1', message: nestedMessage() }, config) as { message: Record<string, unknown> };
    expect(draft.message.subject).toBe('Angebot für Öl — Grüße');
  });

  it('caps the text per message and across the response', () => {
    const long = {
      id: 'm',
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x'.repeat(50)) } },
    };
    const capped = readDecode({ decode: { type: 'gmail-message', maxTextChars: 20, maxTotalChars: 30 } })!;
    const thread = applyDecode({ messages: [long, long, long] }, capped) as { messages: Array<Record<string, unknown>> };
    expect(thread.messages.map((m) => (m.text as string).length)).toEqual([20, 10, 0]);
    expect(thread.messages[0]).toMatchObject({ textTruncated: true, textLength: 50 });
  });

  it('survives malformed payloads', () => {
    const odd = { id: 'm', payload: { headers: 'nope', parts: [null, 5, { mimeType: 'text/plain', body: 'x' }] } };
    expect(applyDecode(odd, config)).toEqual({ id: 'm' });
  });
});

describe('decode config', () => {
  it('validates the type and options', () => {
    expect(validateDecode(undefined)).toBeNull();
    expect(validateDecode('gmail-message')).toBeNull();
    expect(validateDecode({ type: 'gmail-message', maxTextChars: 100 })).toBeNull();
    expect(validateDecode('base64')).toMatch(/decode must be one of/);
    expect(validateDecode({ type: 'gmail-message', maxTextChars: -1 })).toMatch(/positive integer/);
    expect(validateDecode({ type: 'gmail-message', other: 1 })).toMatch(/unknown option "other"/);
  });
});

describe('applyResponseTransform with decode', () => {
  it('leaves a mapping without decode exactly as before (same reference)', () => {
    const raw = nestedMessage();
    expect(applyResponseTransform(raw, { cacheTtl: 60 })).toEqual({ value: raw, applied: false });
    expect(applyResponseTransform(raw, { cacheTtl: 60 }).value).toBe(raw);
    expect(applyResponseTransform(raw, null).value).toBe(raw);
    expect(hasTransform({ decode: 'gmail-message' })).toBe(false);
  });

  it('decodes when the mapping asks for it', () => {
    const out = applyResponseTransform(nestedMessage(), { decode: 'gmail-message' });
    expect(out.applied).toBe(true);
    expect((out.value as Record<string, unknown>).text).toBe('Grüße aus Freiburg\nÄrger? Nein.');
  });

  it('runs a transform on the decoded value', () => {
    const out = applyResponseTransform(nestedMessage(), {
      decode: 'gmail-message',
      transform: { select: { who: '$.from', body: '$.text' } },
    });
    expect(out.value).toEqual({ who: 'Jürgen Müller <juergen@example.de>', body: 'Grüße aus Freiburg\nÄrger? Nein.' });
  });

  it('falls back to the raw response on an invalid decode config', () => {
    const raw = nestedMessage();
    const out = applyResponseTransform(raw, { decode: 'nonsense' });
    expect(out.value).toBe(raw);
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/decode must be one of/);
  });

  it('reports not applied when nothing in the response was a message', () => {
    const list = { messages: [{ id: '1' }] };
    const out = applyResponseTransform(list, { decode: 'gmail-message' });
    expect(out).toEqual({ value: list, applied: false });
  });
});
