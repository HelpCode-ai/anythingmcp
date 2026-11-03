import { Logger } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import imapkit from 'imapkit';
import { SMTPServer } from 'smtp-server';
import { EmailEngine } from './email.engine';
import { EmailConnectorError } from '../email/email-settings';
import { BINARY_MARKER } from '../binary-response.util';

/**
 * EmailEngine against real protocol servers running in this process: ImapKit
 * (an in-memory IMAP server, MIT) and smtp-server (MIT-0, the nodemailer
 * project's SMTP server). No Docker, no network beyond 127.0.0.1, and no real
 * mailbox. Plaintext on loopback, so this is the self-hosted configuration
 * (DEPLOYMENT_MODE unset; the SSRF guard is off under Jest).
 */

const USER = 'anna@example.com';
const PASSWORD = 'Corr3ct-Horse!';

const INVOICE = [
  'From: Shop GmbH <shop@example.org>',
  'To: Anna <anna@example.com>',
  'Subject: Rechnung 4711',
  'Date: Tue, 20 Oct 2026 10:00:00 +0000',
  'Message-ID: <invoice-4711@example.org>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: multipart/alternative; boundary="b2"',
  '',
  '--b2',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Guten Tag Anna, anbei die Rechnung f=C3=BCr Ihre Bestellung.',
  '--b2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Guten Tag Anna</p>',
  '--b2--',
  '--b1',
  'Content-Type: application/pdf; name="Rechnung-4711.pdf"',
  'Content-Disposition: attachment; filename="Rechnung-4711.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.7\nfake invoice\n').toString('base64'),
  '--b1',
  'Content-Type: text/csv; name="items.csv"',
  'Content-Disposition: attachment; filename="items.csv"',
  '',
  'sku;qty',
  'A-1;2',
  '--b1--',
  '',
].join('\r\n');

const NEWSLETTER = [
  'From: News <news@example.net>',
  'To: anna@example.com',
  'Subject: Weekly update',
  'Date: Wed, 21 Oct 2026 10:00:00 +0000',
  'Message-ID: <news-1@example.net>',
  'Content-Type: text/html; charset=utf-8',
  '',
  `<html><body><h2>This week</h2><p>${'Lots of news. '.repeat(400)}</p></body></html>`,
  '',
].join('\r\n');

describe('EmailEngine against ImapKit and smtp-server', () => {
  let imap: ReturnType<typeof imapkit>;
  let imapPort: number;
  let smtp: SMTPServer;
  let smtpPort: number;
  let delivered: Array<{ from: string; to: string[]; data: string }>;
  const engine = new EmailEngine();

  const settings = () => ({
    imapHost: '127.0.0.1',
    imapPort,
    imapSecurity: 'none',
    smtpHost: '127.0.0.1',
    smtpPort,
    smtpSecurity: 'none',
    fromName: 'Anna Schmidt',
  });
  const run = (method: string, params: Record<string, unknown> = {}, password = PASSWORD) =>
    engine.execute({ authConfig: { username: USER, password } }, { method }, params, settings()) as Promise<any>;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    imap = imapkit({
      plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'ID'],
      users: { [USER]: { password: PASSWORD } },
      storage: {
        INBOX: {},
        '': {
          separator: '/',
          folders: {
            Sent: { 'special-use': '\\Sent' },
            Drafts: { 'special-use': '\\Drafts' },
            Trash: { 'special-use': '\\Trash' },
            Projekte: {},
          },
        },
      },
    });
    imapPort = await imap.start(0, '127.0.0.1');
    imap.control.addMessage('INBOX', { raw: INVOICE });
    imap.control.addMessage('INBOX', { raw: NEWSLETTER, flags: ['\\Seen'] });

    delivered = [];
    smtp = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, cb) {
        if (auth.username === USER && auth.password === PASSWORD) cb(null, { user: USER });
        else cb(new Error('535 Authentication failed'));
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          delivered.push({
            from: (session.envelope.mailFrom as { address: string }).address,
            to: session.envelope.rcptTo.map((r) => r.address),
            data: Buffer.concat(chunks).toString('utf8'),
          });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    smtpPort = (smtp.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await imap.stop();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  const folderUids = (path: string) => imap.control.listMessages(path).map((m: { uid: number }) => m.uid);
  const flagsOf = (path: string, uid: number) => imap.control.getMessage(path, uid).flags as string[];

  it('tests the connection: IMAP login and folders, SMTP login', async () => {
    await expect(engine.testConnection({ authConfig: { username: USER, password: PASSWORD } }, settings())).resolves.toEqual({
      folders: 5,
      smtp: 'ok',
    });
  });

  it('reports a wrong password as auth_failed, without the password', async () => {
    const err = (await run('email_list_folders', {}, 'wrong-Passw0rd').catch((e) => e)) as EmailConnectorError;
    expect(err).toBeInstanceOf(EmailConnectorError);
    expect(err.kind).toBe('auth_failed');
    expect(err.message).not.toContain('wrong-Passw0rd');
  });

  it('lists folders with roles and counts', async () => {
    const out = await run('email_list_folders');
    const byPath = Object.fromEntries(out.folders.map((f: any) => [f.path, f]));
    expect(byPath.INBOX).toMatchObject({ role: 'inbox', messages: 2, unread: 1 });
    expect(byPath.Sent.role).toBe('sent');
    expect(byPath.Trash.role).toBe('trash');
    expect(byPath.Projekte).toMatchObject({ messages: 0 });
  });

  it('searches newest first with snippets, and by criteria', async () => {
    const all = await run('email_search');
    expect(all.total).toBe(2);
    expect(all.messages.map((m: any) => m.subject)).toEqual(['Weekly update', 'Rechnung 4711']);
    expect(all.messages[1]).toMatchObject({
      from: 'Shop GmbH <shop@example.org>',
      unread: true,
      hasAttachments: true,
      snippet: 'Guten Tag Anna, anbei die Rechnung für Ihre Bestellung.',
    });
    expect(all.messages[0].snippet).toMatch(/^THIS WEEK Lots of news/);

    const unread = await run('email_search', { unread_only: true });
    expect(unread.messages.map((m: any) => m.subject)).toEqual(['Rechnung 4711']);
    const bySender = await run('email_search', { from: 'news@example.net' });
    expect(bySender.total).toBe(1);
    const bySubject = await run('email_search', { subject: 'Rechnung', since: '2026-01-01' });
    expect(bySubject.total).toBe(1);
  });

  it('reads a message with its attachments, without marking it read', async () => {
    const [uid] = folderUids('INBOX');
    const msg = await run('email_get_message', { uid });
    expect(msg).toMatchObject({
      subject: 'Rechnung 4711',
      messageId: '<invoice-4711@example.org>',
      from: ['Shop GmbH <shop@example.org>'],
      body: { format: 'text', text: 'Guten Tag Anna, anbei die Rechnung für Ihre Bestellung.', truncated: false },
    });
    expect(msg.attachments.map((a: any) => [a.index, a.filename, a.contentType])).toEqual([
      [1, 'Rechnung-4711.pdf', 'application/pdf'],
      [2, 'items.csv', 'text/csv'],
    ]);
    expect(flagsOf('INBOX', uid)).not.toContain('\\Seen');
  });

  it('cuts a long HTML body with a marker', async () => {
    const uid = folderUids('INBOX')[1];
    const msg = await run('email_get_message', { uid, max_chars: 500 });
    expect(msg.body.format).toBe('html_as_text');
    expect(msg.body.truncated).toBe(true);
    expect(msg.body.text).toMatch(/body truncated: showing 500 of \d+ characters/);
  });

  it('downloads attachments as a file and as text', async () => {
    const [uid] = folderUids('INBOX');
    const pdf = await run('email_get_attachment', { uid, index: 1 });
    expect(pdf[BINARY_MARKER]).toBe(1);
    expect(pdf.filename).toBe('Rechnung-4711.pdf');
    expect(Buffer.from(pdf.base64, 'base64').toString()).toBe('%PDF-1.7\nfake invoice\n');
    const csv = await run('email_get_attachment', { uid, index: 2 });
    expect(csv.text.replace(/\r\n/g, '\n').trim()).toBe('sku;qty\nA-1;2');
  });

  it('flags, moves and deletes to the Trash without expunging anything', async () => {
    const [invoice, news] = folderUids('INBOX');
    await run('email_set_flags', { uids: [invoice], seen: true, flagged: true });
    expect(flagsOf('INBOX', invoice)).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']));

    const moved = await run('email_move', { uids: [invoice], destination: 'Projekte' });
    expect(moved.moved).toBe(1);
    expect(folderUids('Projekte')).toHaveLength(1);

    await run('email_delete', { uids: [news] });
    expect(folderUids('INBOX')).toHaveLength(0);
    expect(folderUids('Trash')).toHaveLength(1);
    // Never a \Deleted flag: the provider empties the Trash, not us.
    expect(flagsOf('Trash', folderUids('Trash')[0])).not.toContain('\\Deleted');
  });

  it('saves a draft in Drafts', async () => {
    const out = await run('email_save_draft', { to: ['bob@example.org'], subject: 'Angebot', text: 'Entwurf' });
    expect(out.folder).toBe('Drafts');
    const [draft] = imap.control.listMessages('Drafts', { raw: true });
    expect(draft.flags).toEqual(expect.arrayContaining(['\\Draft']));
    expect(String(draft.raw)).toMatch(/Subject: Angebot/);
    expect(delivered).toHaveLength(0);
  });

  it('sends through SMTP, keeps Bcc off the wire and files the copy in Sent', async () => {
    const out = await run('email_send', {
      to: ['Bob <bob@example.org>'],
      bcc: ['boss@example.com'],
      subject: 'Lieferung',
      text: 'Die Ware ist unterwegs.',
    });
    expect(out).toMatchObject({ sent: true, savedTo: 'Sent', recipients: 2 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].from).toBe(USER);
    expect(delivered[0].to).toEqual(['bob@example.org', 'boss@example.com']);
    expect(delivered[0].data).not.toMatch(/^Bcc:/im);
    expect(delivered[0].data).toMatch(/^From: Anna Schmidt <anna@example\.com>/m);
    const [copy] = imap.control.listMessages('Sent', { raw: true });
    expect(String(copy.raw)).toMatch(/^Bcc: boss@example\.com/m);
    expect(String(copy.raw)).toContain(out.messageId);
  });

  it('replies in the thread and marks the original as answered', async () => {
    const [invoice] = folderUids('INBOX');
    await run('email_send', { in_reply_to_uid: invoice, text: 'Danke, bezahlt.' });
    expect(delivered[0].to).toEqual(['shop@example.org']);
    expect(delivered[0].data).toMatch(/^In-Reply-To: <invoice-4711@example\.org>/m);
    expect(delivered[0].data).toMatch(/^References: <invoice-4711@example\.org>/m);
    expect(delivered[0].data).toMatch(/^Subject: Re: Rechnung 4711/m);
    expect(flagsOf('INBOX', invoice)).toContain('\\Answered');
  });
});

describe('EmailEngine over TLS with a self-signed certificate (ImapKit)', () => {
  let imap: ReturnType<typeof imapkit>;
  let port: number;
  const engine = new EmailEngine();
  const auth = { authConfig: { username: USER, password: PASSWORD } };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // ImapKit's bundled test certificate: self-signed, for localhost / 127.0.0.1.
    imap = imapkit({ secureConnection: true, users: { [USER]: { password: PASSWORD } } });
    port = await imap.start(0, '127.0.0.1');
  });
  afterAll(async () => {
    await imap.stop();
    jest.restoreAllMocks();
  });

  it('refuses the certificate by default, with a TLS error', async () => {
    const err = (await engine
      .execute(auth, { method: 'email_list_folders' }, {}, { imapHost: '127.0.0.1', imapPort: port, imapSecurity: 'tls' })
      .catch((e) => e)) as EmailConnectorError;
    expect(err).toBeInstanceOf(EmailConnectorError);
    expect(err.kind).toBe('tls');
  });

  it('accepts it self-hosted when "accept self-signed certificate" is on', async () => {
    const out = (await engine.execute(
      auth,
      { method: 'email_list_folders' },
      {},
      { imapHost: '127.0.0.1', imapPort: port, imapSecurity: 'tls', allowSelfSigned: true },
    )) as { folders: Array<{ path: string }> };
    expect(out.folders.map((f) => f.path)).toContain('INBOX');
  });
});

describe('EmailEngine SMTP authentication on Cloud (smtp-server without AUTH)', () => {
  let smtp: SMTPServer;
  let port: number;
  let delivered: number;
  const env = process.env.DEPLOYMENT_MODE;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delivered = 0;
    // An open relay: accepts mail from anyone and does not offer AUTH.
    smtp = new SMTPServer({
      disabledCommands: ['STARTTLS', 'AUTH'],
      authOptional: true,
      logger: false,
      onData(stream, _session, cb) {
        stream.on('data', () => undefined);
        stream.on('end', () => {
          delivered++;
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    port = (smtp.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    if (env === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = env;
    jest.restoreAllMocks();
  });

  it('refuses to send through a server that does not authenticate', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    const engine = new EmailEngine();
    // Cloud only accepts standard ports and TLS; the local relay listens on a
    // random plaintext port, so the transport is pointed at it underneath.
    const real = engine.smtpFactory;
    engine.smtpFactory = (options) =>
      real({ ...options, host: '127.0.0.1', port, secure: false, requireTLS: false, ignoreTLS: true, servername: undefined, tls: {} });
    const err = (await engine
      .execute(
        { authConfig: { username: USER, password: PASSWORD } },
        { method: 'email_send' },
        { to: 'bob@example.org', text: 'x' },
        { imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', smtpPort: 2525, saveSent: 'never' },
      )
      .catch((e) => e)) as EmailConnectorError;
    expect(err).toBeInstanceOf(EmailConnectorError);
    expect(delivered).toBe(0);
  });

  it('(control) the same relay accepts the message when the login is not forced', async () => {
    delete process.env.DEPLOYMENT_MODE;
    const engine = new EmailEngine();
    const out = (await engine.execute(
      { authConfig: { username: USER, password: PASSWORD } },
      { method: 'email_send' },
      { to: 'bob@example.org', text: 'x' },
      { imapHost: '127.0.0.1', smtpHost: '127.0.0.1', smtpPort: port, smtpSecurity: 'none', saveSent: 'never' },
    )) as { sent: boolean };
    expect(out.sent).toBe(true);
    expect(delivered).toBe(1);
  });
});
