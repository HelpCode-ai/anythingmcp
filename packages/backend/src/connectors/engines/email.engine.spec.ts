import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { EmailEngine, type ImapClient, type SmtpTransport } from './email.engine';
import { EmailConnectorError } from '../email/email-settings';
import { SsrfBlockedError } from '../../common/ssrf.util';
import { BINARY_MARKER } from '../binary-response.util';

/**
 * EmailEngine against a scripted IMAP client and SMTP transport: what the
 * engine asks the server for, and what it does with the answers. The real
 * protocol round trip is in email.engine.integration.spec.ts.
 */

const PASSWORD = 'S3cret-Pa55word!';
const AUTH = { username: 'anna@example.com', password: PASSWORD };
const SETTINGS = { imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' };

interface FakeMessage {
  uid: number;
  envelope?: Record<string, unknown>;
  flags?: Set<string>;
  size?: number;
  internalDate?: Date;
  bodyStructure?: Record<string, unknown>;
  headers?: Buffer;
  parts?: Record<string, Buffer | string>;
}

class FakeImap {
  calls: Array<[string, ...unknown[]]> = [];
  folders = [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>(), status: { messages: 2, unseen: 1 } },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent', flags: new Set<string>(), status: { messages: 0, unseen: 0 } },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', flags: new Set<string>(), status: { messages: 0, unseen: 0 } },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set<string>(), status: { messages: 0, unseen: 0 } },
    { path: 'Archive', name: 'Archive', flags: new Set<string>(), status: { messages: 5, unseen: 0 } },
  ];
  messages: FakeMessage[] = [];
  searchResult: number[] = [];
  capabilities = new Map<string, boolean | number>([['IMAP4rev1', true], ['MOVE', true], ['UIDPLUS', true]]);
  failConnect?: Error;
  failAppend?: Error;

  connect = jest.fn(async () => {
    this.calls.push(['connect']);
    if (this.failConnect) throw this.failConnect;
  });
  logout = jest.fn(async () => {
    this.calls.push(['logout']);
  });
  close = jest.fn();
  on = jest.fn();
  list = jest.fn(async () => this.folders);
  getMailboxLock = jest.fn(async (path: string, opts: unknown) => {
    this.calls.push(['lock', path, opts]);
    return { path, release: jest.fn() };
  });
  search = jest.fn(async (query: unknown, opts: unknown) => {
    this.calls.push(['search', query, opts]);
    return this.searchResult;
  });
  fetchAll = jest.fn(async (range: number[]) => this.messages.filter((m) => range.includes(m.uid)));
  fetchOne = jest.fn(async (uid: string, query: unknown) => {
    this.calls.push(['fetchOne', uid, query]);
    return this.messages.find((m) => String(m.uid) === uid) ?? false;
  });
  download = jest.fn(async (uid: string, part: string, opts: { maxBytes: number }) => {
    this.calls.push(['download', uid, part, opts]);
    const msg = this.messages.find((m) => String(m.uid) === uid);
    const data = msg?.parts?.[part];
    if (data === undefined) return { meta: {}, content: null };
    const buf = Buffer.from(data);
    return { meta: {}, content: Readable.from([buf.subarray(0, opts.maxBytes)]) };
  });
  messageFlagsAdd = jest.fn(async (...args: unknown[]) => {
    this.calls.push(['flagsAdd', ...args]);
    return true;
  });
  messageFlagsRemove = jest.fn(async (...args: unknown[]) => {
    this.calls.push(['flagsRemove', ...args]);
    return true;
  });
  messageMove = jest.fn(async (range: string, dest: string) => {
    this.calls.push(['move', range, dest]);
    return { path: 'INBOX', destination: dest, uidMap: new Map([[Number(range.split(',')[0]), 900]]) };
  });
  append = jest.fn(async (path: string, content: string, flags: string[]) => {
    this.calls.push(['append', path, content, flags]);
    if (this.failAppend) throw this.failAppend;
    return { destination: path, uid: 77 };
  });
  messageDelete = jest.fn();
}

class FakeSmtp implements SmtpTransport {
  sent: Array<{ envelope: { from: string; to: string[] }; raw: string }> = [];
  verify = jest.fn(async () => true);
  close = jest.fn();
  fail?: Error;
  async sendMail(mail: { envelope: { from: string; to: string[] }; raw: string }) {
    if (this.fail) throw this.fail;
    this.sent.push(mail);
    return { accepted: mail.envelope.to };
  }
}

function setup() {
  const engine = new EmailEngine();
  const imap = new FakeImap();
  const smtp = new FakeSmtp();
  const imapOptions: Array<Record<string, unknown>> = [];
  const smtpOptions: Array<Record<string, unknown>> = [];
  engine.imapFactory = (options) => {
    imapOptions.push(options as Record<string, unknown>);
    return imap as unknown as ImapClient;
  };
  engine.smtpFactory = (options) => {
    smtpOptions.push(options);
    return smtp;
  };
  const run = (method: string, params: Record<string, unknown> = {}, settings: Record<string, unknown> = SETTINGS, auth: Record<string, unknown> = AUTH) =>
    engine.execute({ authConfig: auth }, { method }, params, settings);
  return { engine, imap, smtp, imapOptions, smtpOptions, run };
}

const env = { ...process.env };
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});

describe('EmailEngine: connections', () => {
  it('opens one IMAP connection per call with timeouts, no idle, no logger, and logs out', async () => {
    const { imap, imapOptions, run } = setup();
    await run('email_list_folders');
    expect(imapOptions).toHaveLength(1);
    expect(imapOptions[0]).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      tls: { rejectUnauthorized: true },
      auth: { user: 'anna@example.com', pass: PASSWORD },
    });
    expect(imap.calls[0]).toEqual(['connect']);
    expect(imap.calls[imap.calls.length - 1]).toEqual(['logout']);
  });

  it('requires STARTTLS rather than falling back to clear text', async () => {
    const { imapOptions, run } = setup();
    await run('email_list_folders', {}, { ...SETTINGS, imapPort: '143' });
    expect(imapOptions[0]).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
  });

  it('closes the socket when logout fails after a broken connection', async () => {
    const { imap, run } = setup();
    imap.failConnect = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:993'), { code: 'ECONNREFUSED' });
    imap.logout.mockRejectedValueOnce(new Error('not connected'));
    await expect(run('email_list_folders')).rejects.toMatchObject({ kind: 'unreachable' });
    expect(imap.close).toHaveBeenCalled();
  });

  it('lists folders with roles and counts', async () => {
    const { run } = setup();
    const out = (await run('email_list_folders')) as { folders: Array<Record<string, unknown>> };
    expect(out.folders[0]).toEqual({ path: 'INBOX', name: 'INBOX', role: 'inbox', messages: 2, unread: 1 });
    expect(out.folders[4]).toEqual({ path: 'Archive', name: 'Archive', role: undefined, messages: 5, unread: 0 });
  });
});

describe('EmailEngine: SSRF guard', () => {
  beforeEach(() => {
    process.env.SSRF_GUARD = 'enabled';
  });

  it('refuses a loopback or private mail server on Cloud before connecting', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { imapOptions, run } = setup();
    await expect(run('email_list_folders', {}, { imapHost: '127.0.0.1' })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(run('email_list_folders', {}, { imapHost: '10.0.0.5' })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(run('email_list_folders', {}, { imapHost: '169.254.169.254' })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(imapOptions).toHaveLength(0);
  });

  it('refuses the SMTP host too', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { smtpOptions, imapOptions, engine } = setup();
    // saveSent never and no reply: SMTP is the only connection.
    await expect(
      engine.execute({ authConfig: AUTH }, { method: 'email_send' }, { to: 'b@example.org', text: 'x' }, { imapHost: 'imap.example.com', smtpHost: '192.168.1.10', saveSent: 'never' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(smtpOptions).toHaveLength(0);
    expect(imapOptions).toHaveLength(0);
  });

  it('lets a self-hosted admin allowlist an internal mail server', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'mail.internal';
    const { imapOptions, run } = setup();
    await run('email_list_folders', {}, { imapHost: 'mail.internal', imapSecurity: 'none', imapPort: 143 });
    // Allowlisted: connected by name.
    expect(imapOptions[0]).toMatchObject({ host: 'mail.internal', servername: 'mail.internal', doSTARTTLS: false });
  });

  it('connects to the address the guard checked and keeps the name for TLS', async () => {
    process.env.SSRF_ALLOW_LOCALHOST = 'true';
    const { imapOptions, run } = setup();
    await run('email_list_folders', {}, { imapHost: 'localhost' });
    expect(imapOptions[0].servername).toBe('localhost');
    expect(['127.0.0.1', '::1']).toContain(imapOptions[0].host);
  });

  it('refuses plaintext on Cloud before any DNS or socket', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { imapOptions, run } = setup();
    await expect(run('email_list_folders', {}, { imapHost: 'imap.example.com', imapSecurity: 'none', imapPort: 143 })).rejects.toThrow(
      /without encryption/,
    );
    expect(imapOptions).toHaveLength(0);
  });
});

describe('EmailEngine: search', () => {
  function seed(imap: FakeImap) {
    imap.searchResult = [3, 12, 7];
    imap.messages = [
      {
        uid: 12,
        envelope: { date: new Date('2026-10-20T10:00:00Z'), subject: 'Newest', from: [{ name: 'Bob', address: 'bob@example.org' }], to: [{ address: 'anna@example.com' }] },
        flags: new Set(['\\Seen']),
        size: 1234,
        internalDate: new Date('2026-10-20T10:00:01Z'),
        bodyStructure: { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }] },
        parts: { '1': 'Hello   Anna,\n\nthe invoice is attached.' },
      },
      {
        uid: 7,
        envelope: { date: new Date('2026-10-10T10:00:00Z'), subject: 'Older', from: [{ address: 'carl@example.org' }], to: [] },
        flags: new Set(),
        size: 99,
        internalDate: new Date('2026-10-10T10:00:00Z'),
        bodyStructure: { type: 'text/html' },
        parts: { '1': '<p>Price <b>update</b></p>' },
      },
    ];
  }

  it('maps the criteria, opens the folder read-only and returns newest first', async () => {
    const { imap, run } = setup();
    seed(imap);
    const out = (await run('email_search', { folder: 'INBOX', from: 'bob', unread_only: true, since: '2026-10-01', limit: 2 })) as any;
    expect(imap.calls.find((c) => c[0] === 'lock')).toEqual(['lock', 'INBOX', { readOnly: true }]);
    expect(imap.calls.find((c) => c[0] === 'search')).toEqual([
      'search',
      { from: 'bob', since: new Date(Date.UTC(2026, 9, 1)), seen: false },
      { uid: true },
    ]);
    // The two highest UIDs of three matches.
    expect(imap.fetchAll.mock.calls[0][0]).toEqual([12, 7]);
    expect(out.total).toBe(3);
    expect(out.returned).toBe(2);
    expect(out.note).toMatch(/1 older matches/);
    expect(out.messages.map((m: any) => m.uid)).toEqual([12, 7]);
    expect(out.messages[0]).toMatchObject({
      from: 'Bob <bob@example.org>',
      subject: 'Newest',
      unread: false,
      hasAttachments: true,
      snippet: 'Hello Anna, the invoice is attached.',
    });
    expect(out.messages[1]).toMatchObject({ unread: true, hasAttachments: false, snippet: 'Price update' });
    // Snippets read only the first bytes of each body.
    const downloads = imap.calls.filter((c) => c[0] === 'download');
    expect(downloads.every((c) => (c[3] as { maxBytes: number }).maxBytes <= 4096)).toBe(true);
  });

  it('caps the limit at 100 and skips snippets when asked', async () => {
    const { imap, run } = setup();
    imap.searchResult = Array.from({ length: 250 }, (_, i) => i + 1);
    imap.messages = [];
    await run('email_search', { limit: 5000, include_snippets: false });
    expect(imap.fetchAll.mock.calls[0][0]).toHaveLength(100);
    expect(imap.fetchAll.mock.calls[0][0][0]).toBe(250);
    expect(imap.download).not.toHaveBeenCalled();
  });

  it('says which folder does not exist', async () => {
    const { imap, run } = setup();
    imap.getMailboxLock.mockRejectedValueOnce(Object.assign(new Error('Command failed'), { responseText: "Mailbox doesn't exist: Rechnungen" }));
    await expect(run('email_search', { folder: 'Rechnungen' })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringMatching(/no folder "Rechnungen".*list_folders/),
    });
  });
});

describe('EmailEngine: get_message', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/html', size: 100 },
      { part: '2', type: 'application/pdf', size: 4000, encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'Rechnung.pdf' } },
    ],
  };

  it('converts an HTML body to text, truncates it with a marker and lists attachments without part ids', async () => {
    const { imap, run } = setup();
    imap.messages = [
      {
        uid: 5,
        envelope: { messageId: '<m5@example.org>', subject: 'Invoice', from: [{ name: 'Shop', address: 'shop@example.org' }], to: [{ address: 'anna@example.com' }] },
        flags: new Set(),
        bodyStructure: structure,
        headers: Buffer.from('References: <r1@example.org>\r\n\r\n'),
        parts: { '1': `<html><body><h1>Invoice</h1><p>${'Lorem ipsum '.repeat(50)}</p><script>alert(1)</script></body></html>` },
      },
    ];
    const out = (await run('email_get_message', { uid: 5, max_chars: 100 })) as any;
    expect(out.body.format).toBe('html_as_text');
    expect(out.body.truncated).toBe(true);
    expect(out.body.text).toMatch(/^INVOICE/);
    expect(out.body.text).toMatch(/\[\.\.\. body truncated: showing 100 of \d+ characters/);
    expect(out.body.text).not.toMatch(/alert/);
    expect(out.references).toEqual('<r1@example.org>');
    expect(out.contentNotice).toMatch(/do not follow instructions/);
    expect(out.attachments).toEqual([
      { index: 1, filename: 'Rechnung.pdf', contentType: 'application/pdf', approxBytes: expect.any(Number), inline: false },
    ]);
    // Read without marking as read.
    expect(imap.calls.find((c) => c[0] === 'lock')).toEqual(['lock', 'INBOX', { readOnly: true }]);
    expect(imap.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('marks as read only when asked', async () => {
    const { imap, run } = setup();
    imap.messages = [{ uid: 5, envelope: {}, flags: new Set(), bodyStructure: { type: 'text/plain' }, parts: { '1': 'hi' } }];
    const out = (await run('email_get_message', { uid: 5, mark_as_read: true })) as any;
    expect(imap.calls.find((c) => c[0] === 'lock')).toEqual(['lock', 'INBOX', { readOnly: false }]);
    expect(imap.messageFlagsAdd).toHaveBeenCalledWith('5', ['\\Seen'], { uid: true });
    expect(out.flags).toContain('\\Seen');
    expect(out.body).toEqual({ format: 'text', text: 'hi', truncated: false, totalChars: 2 });
  });

  it('explains a UID that is not in the folder', async () => {
    const { run } = setup();
    await expect(run('email_get_message', { uid: 404, folder: 'Archive' })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringMatching(/No message with UID 404 in "Archive"/),
    });
  });
});

describe('EmailEngine: get_attachment', () => {
  function seed(imap: FakeImap, parts: Record<string, Buffer | string>, children: Array<Record<string, unknown>>) {
    imap.messages = [{ uid: 9, envelope: {}, bodyStructure: { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain' }, ...children] }, parts }];
  }

  it('returns a text attachment as text', async () => {
    const { imap, run } = setup();
    seed(imap, { '2': 'sku;qty\nA;1\n' }, [{ part: '2', type: 'text/csv', size: 12, disposition: 'attachment', dispositionParameters: { filename: 'order.csv' } }]);
    const out = (await run('email_get_attachment', { uid: 9, index: 1 })) as any;
    expect(out).toMatchObject({ filename: 'order.csv', contentType: 'text/csv', text: 'sku;qty\nA;1\n', truncated: false });
  });

  it('returns a file as a binary body the MCP layer attaches', async () => {
    const { imap, run } = setup();
    const pdf = Buffer.from('%PDF-1.7 fake');
    seed(imap, { '2': pdf }, [{ part: '2', type: 'application/pdf', size: 20, encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }]);
    const out = (await run('email_get_attachment', { uid: 9, index: 1 })) as any;
    expect(out).toEqual({ [BINARY_MARKER]: 1, contentType: 'application/pdf', bytes: pdf.length, filename: 'a.pdf', base64: pdf.toString('base64') });
  });

  it('refuses an attachment above 4 MB without downloading it', async () => {
    const { imap, run } = setup();
    seed(imap, {}, [{ part: '2', type: 'application/zip', size: 8 * 1024 * 1024, encoding: 'base64', disposition: 'attachment', dispositionParameters: { filename: 'big.zip' } }]);
    await expect(run('email_get_attachment', { uid: 9, index: 1 })).rejects.toThrow(/"big.zip" is about 5\.\d MB, above the 4\.0 MB limit/);
    expect(imap.download).not.toHaveBeenCalled();
  });

  it('stops a download that turns out larger than the cap', async () => {
    const { imap, run } = setup();
    seed(imap, { '2': Buffer.alloc(4 * 1024 * 1024 + 10) }, [{ part: '2', type: 'application/octet-stream', size: 100, disposition: 'attachment', dispositionParameters: { filename: 'liar.bin' } }]);
    await expect(run('email_get_attachment', { uid: 9, index: 1 })).rejects.toThrow(/liar\.bin/);
    expect(imap.calls.find((c) => c[0] === 'download')?.[3]).toEqual({ uid: true, maxBytes: 4 * 1024 * 1024 + 1 });
  });

  it('names the valid range for a wrong index', async () => {
    const { imap, run } = setup();
    seed(imap, {}, [{ part: '2', type: 'image/png', disposition: 'attachment', dispositionParameters: { filename: 'a.png' } }]);
    await expect(run('email_get_attachment', { uid: 9, index: 3 })).rejects.toThrow(/between 1 and 1/);
  });
});

describe('EmailEngine: changing the mailbox', () => {
  it('sets and clears flags by UID', async () => {
    const { imap, run } = setup();
    await run('email_set_flags', { uids: [4, 5], seen: false, flagged: true });
    expect(imap.messageFlagsRemove).toHaveBeenCalledWith('4,5', ['\\Seen'], { uid: true });
    expect(imap.messageFlagsAdd).toHaveBeenCalledWith('4,5', ['\\Flagged'], { uid: true });
    await expect(run('email_set_flags', { uids: [4] })).rejects.toThrow(/seen, flagged, or both/);
  });

  it('moves to an existing folder and reports the new UIDs', async () => {
    const { imap, run } = setup();
    const out = (await run('email_move', { uids: [4], destination: 'Archive' })) as any;
    expect(imap.messageMove).toHaveBeenCalledWith('4', 'Archive', { uid: true });
    expect(out.newUids).toEqual({ 4: 900 });
    await expect(run('email_move', { uids: [4], destination: 'Nope' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses to move on a server whose move fallback would expunge other messages', async () => {
    const { imap, run } = setup();
    imap.capabilities = new Map([['IMAP4rev1', true]]);
    await expect(run('email_move', { uids: [4], destination: 'Archive' })).rejects.toThrow(/neither IMAP MOVE nor UIDPLUS/);
    expect(imap.messageMove).not.toHaveBeenCalled();
  });

  it('deletes by moving to the Trash, never by expunging', async () => {
    const { imap, run } = setup();
    const out = (await run('email_delete', { uids: [4] })) as any;
    expect(imap.messageMove).toHaveBeenCalledWith('4', 'Trash', { uid: true });
    expect(imap.messageDelete).not.toHaveBeenCalled();
    expect(out.note).toMatch(/not deleted permanently/);
    await expect(run('email_delete', { uids: [4], folder: 'Trash' })).rejects.toThrow(/already in the Trash/);
  });

  it('saves a draft in the Drafts folder with the Draft flag', async () => {
    const { imap, smtp, run } = setup();
    const out = (await run('email_save_draft', { to: ['bob@example.org'], subject: 'Offer', text: 'Hello' })) as any;
    const append = imap.calls.find((c) => c[0] === 'append')!;
    expect(append[1]).toBe('Drafts');
    expect(append[3]).toEqual(['\\Draft', '\\Seen']);
    expect(String(append[2])).toMatch(/^Date: .+\r\nMessage-ID: <[^>]+@example\.com>\r\n/);
    expect(String(append[2])).toMatch(/\r\nFrom: anna@example\.com\r\n/);
    expect(out).toMatchObject({ saved: true, folder: 'Drafts', uid: 77 });
    expect(smtp.sent).toHaveLength(0);
  });
});

describe('EmailEngine: send', () => {
  const original: FakeMessage = {
    uid: 31,
    envelope: {
      messageId: '<orig@example.org>',
      subject: 'Angebot 2026',
      from: [{ name: 'Muller, Ben', address: 'ben@example.org' }],
      replyTo: [{ address: 'sales@example.org' }],
    },
    headers: Buffer.from('References: <root@example.org>\r\n\r\n'),
    bodyStructure: { type: 'text/plain' },
  };

  it('threads a reply: In-Reply-To, References, Re: subject, Reply-To as recipient', async () => {
    const { imap, smtp, run } = setup();
    imap.messages = [original];
    await run('email_send', { in_reply_to_uid: 31, text: 'Thanks!' });
    const raw = smtp.sent[0].raw;
    expect(raw).toMatch(/\r\nIn-Reply-To: <orig@example\.org>\r\n/);
    expect(raw).toMatch(/\r\nReferences: <root@example\.org> <orig@example\.org>\r\n/);
    expect(raw).toMatch(/\r\nSubject: Re: Angebot 2026\r\n/);
    expect(smtp.sent[0].envelope).toEqual({ from: 'anna@example.com', to: ['sales@example.org'] });
    // The original is marked as answered.
    expect(imap.messageFlagsAdd).toHaveBeenCalledWith('31', ['\\Answered'], { uid: true });
  });

  it('sends Bcc in the envelope only, and files the copy with Bcc in Sent', async () => {
    const { imap, smtp, run } = setup();
    const out = (await run('email_send', {
      to: ['bob@example.org'],
      cc: 'carl@example.org',
      bcc: ['boss@example.com'],
      subject: 'Hi',
      text: 'Hello',
    })) as any;
    expect(smtp.sent[0].envelope.to).toEqual(['bob@example.org', 'carl@example.org', 'boss@example.com']);
    expect(smtp.sent[0].raw).not.toMatch(/Bcc:/i);
    const append = imap.calls.find((c) => c[0] === 'append')!;
    expect(append[1]).toBe('Sent');
    expect(String(append[2])).toMatch(/\r\nBcc: boss@example\.com\r\n/);
    // Same Message-ID on the wire and in Sent.
    const id = /Message-ID: (<[^>]+>)/.exec(smtp.sent[0].raw)![1];
    expect(String(append[2])).toContain(id);
    expect(out).toMatchObject({ sent: true, savedTo: 'Sent', recipients: 3 });
  });

  it('leaves Gmail to file its own copy and then needs no IMAP connection', async () => {
    const { imapOptions, smtp, run } = setup();
    const out = (await run('email_send', { to: 'bob@example.org', text: 'x' }, { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' })) as any;
    expect(smtp.sent).toHaveLength(1);
    expect(imapOptions).toHaveLength(0);
    expect(out.savedTo).toBe('filed by the provider');
  });

  it('reports, without throwing, a Sent copy that failed after the mail left', async () => {
    const { imap, smtp, run } = setup();
    imap.failAppend = new Error('NO [OVERQUOTA] Quota exceeded');
    const out = (await run('email_send', { to: 'bob@example.org', text: 'x' })) as any;
    expect(smtp.sent).toHaveLength(1);
    expect(out.sent).toBe(true);
    expect(out.warnings[0]).toMatch(/sent, but filing a copy in Sent failed/);
  });

  it('uses the separate SMTP login and the configured sender', async () => {
    const { smtpOptions, smtp, run } = setup();
    await run(
      'email_send',
      { to: 'bob@example.org', text: 'x' },
      { ...SETTINGS, fromAddress: 'info@example.com', fromName: 'Example GmbH', smtpPort: '587', saveSent: 'never' },
      { ...AUTH, smtpUsername: 'relay-user', smtpPassword: 'relay-pass' },
    );
    expect(smtpOptions[0]).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'relay-user', pass: 'relay-pass' },
      connectionTimeout: 15_000,
      socketTimeout: 60_000,
      logger: false,
    });
    expect(smtp.sent[0].raw).toMatch(/\r\nFrom: "?Example GmbH"? <info@example\.com>\r\n/);
    expect(smtp.sent[0].envelope.from).toBe('info@example.com');
  });

  it('refuses header injection, too many recipients and an empty body', async () => {
    const { smtp, run } = setup();
    await expect(run('email_send', { to: 'bob@example.org', subject: 'x\r\nBcc: evil@example.org', text: 'x' })).rejects.toMatchObject({ kind: 'invalid_input' });
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.org`);
    await expect(run('email_send', { to: many, text: 'x' })).rejects.toThrow(/At most 50 recipients/);
    await expect(run('email_send', { to: 'bob@example.org' })).rejects.toThrow(/text, html, or both/);
    expect(smtp.sent).toHaveLength(0);
  });

  it('refuses to send without an SMTP server', async () => {
    const { run } = setup();
    await expect(run('email_send', { to: 'bob@example.org', text: 'x' }, { imapHost: 'imap.example.com' })).rejects.toThrow(/no SMTP server/);
  });
});

describe('EmailEngine: SMTP on Cloud', () => {
  const timeout = () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });

  it('says that the hosting provider blocks the port, fast, and sends nothing', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { smtp, smtpOptions, run } = setup();
    smtp.fail = timeout();
    const err = (await run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, smtpPort: '587', saveSent: 'never' }).catch(
      (e) => e,
    )) as EmailConnectorError;
    expect(err.kind).toBe('smtp_blocked');
    expect(err.message).toMatch(/hosting provider blocks outgoing SMTP on ports 25, 465 and 587/);
    expect(err.message).toMatch(/save_draft/);
    expect(err.message).toMatch(/2525/);
    expect(smtpOptions[0]).toMatchObject({ port: 587, connectionTimeout: 5_000, greetingTimeout: 5_000 });
    expect(smtp.sent).toHaveLength(0);
  });

  it('treats 465 the same way, and a refused connection like a timeout', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { smtp, run } = setup();
    smtp.fail = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
    await expect(run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, saveSent: 'never' })).rejects.toMatchObject({
      kind: 'smtp_blocked',
    });
  });

  it('keeps the ordinary message on port 2525 and when self-hosted', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const cloud = setup();
    cloud.smtp.fail = timeout();
    await expect(
      cloud.run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, smtpPort: '2525', saveSent: 'never' }),
    ).rejects.toMatchObject({ kind: 'unreachable' });
    expect(cloud.smtpOptions[0]).toMatchObject({ connectionTimeout: 15_000 });

    delete process.env.DEPLOYMENT_MODE;
    const selfHosted = setup();
    selfHosted.smtp.fail = timeout();
    await expect(
      selfHosted.run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, smtpPort: '587', saveSent: 'never' }),
    ).rejects.toMatchObject({ kind: 'unreachable' });
    expect(selfHosted.smtpOptions[0]).toMatchObject({ connectionTimeout: 15_000 });
  });

  it('test connection reports IMAP working and SMTP blocked instead of failing', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { engine, smtp } = setup();
    smtp.verify.mockRejectedValueOnce(timeout());
    const out = await engine.testConnection({ authConfig: AUTH }, { ...SETTINGS, smtpPort: '587' });
    expect(out).toMatchObject({ folders: 5, smtp: 'blocked', smtpMessage: expect.stringMatching(/port 587/) });
  });

  it('forces SMTP authentication on Cloud, so an open relay is never used unauthenticated', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const cloud = setup();
    await cloud.run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, saveSent: 'never' });
    expect(cloud.smtpOptions[0]).toMatchObject({ forceAuth: true, auth: { user: 'anna@example.com', pass: PASSWORD } });

    delete process.env.DEPLOYMENT_MODE;
    const selfHosted = setup();
    await selfHosted.run('email_send', { to: 'bob@example.org', text: 'x' }, { ...SETTINGS, saveSent: 'never' });
    expect(selfHosted.smtpOptions[0].forceAuth).toBeUndefined();
    expect(selfHosted.smtpOptions[0].auth).toEqual({ user: 'anna@example.com', pass: PASSWORD });
  });
});

describe('EmailEngine: no credentials in errors or logs', () => {
  it('scrubs the password and its AUTH encodings from server messages and log lines', async () => {
    const warn = Logger.prototype.warn as unknown as jest.Mock;
    const { imap, run } = setup();
    const plain = Buffer.from(`\u0000anna@example.com\u0000${PASSWORD}`).toString('base64');
    imap.failConnect = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: `Invalid credentials for ${PASSWORD} (${plain})`,
    });
    const err = (await run('email_list_folders').catch((e) => e)) as EmailConnectorError;
    expect(err).toBeInstanceOf(EmailConnectorError);
    expect(err.kind).toBe('auth_failed');
    expect(err.message).toMatch(/refused the login/);
    expect(err.message).toMatch(/app password/);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).not.toContain(plain);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(plain);
  });

  it('scrubs the SMTP password from an SMTP error', async () => {
    const { smtp, run } = setup();
    smtp.fail = Object.assign(new Error(`Invalid login: 535 5.7.8 relay-pass rejected`), { code: 'EAUTH' });
    const err = (await run(
      'email_send',
      { to: 'bob@example.org', text: 'x' },
      { ...SETTINGS, saveSent: 'never' },
      { ...AUTH, smtpPassword: 'relay-pass' },
    ).catch((e) => e)) as EmailConnectorError;
    expect(err.kind).toBe('auth_failed');
    expect(err.message).not.toContain('relay-pass');
  });

  it('explains a certificate problem, with the self-signed switch only when self-hosted', async () => {
    const { imap, run } = setup();
    imap.failConnect = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await expect(run('email_list_folders')).rejects.toMatchObject({ kind: 'tls', message: expect.stringMatching(/Accept self-signed certificate/) });
    process.env.DEPLOYMENT_MODE = 'cloud';
    const cloud = setup();
    cloud.imap.failConnect = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await expect(cloud.run('email_list_folders')).rejects.toMatchObject({ kind: 'tls', message: expect.not.stringMatching(/self-signed certificate" in/) });
  });

  it('refuses a method that is not an email tool', async () => {
    const { run } = setup();
    await expect(run('GET')).rejects.toThrow(/not an email tool/);
  });
});

describe('EmailEngine: test connection', () => {
  it('logs in to IMAP, lists folders and verifies SMTP', async () => {
    const { engine, smtp } = setup();
    await expect(engine.testConnection({ authConfig: AUTH }, SETTINGS)).resolves.toEqual({ folders: 5, smtp: 'ok' });
    expect(smtp.verify).toHaveBeenCalled();
    expect(smtp.close).toHaveBeenCalled();
  });

  it('says when no SMTP server is set', async () => {
    const { engine } = setup();
    await expect(engine.testConnection({ authConfig: AUTH }, { imapHost: 'imap.example.com' })).resolves.toEqual({
      folders: 5,
      smtp: 'not_configured',
    });
  });
});
