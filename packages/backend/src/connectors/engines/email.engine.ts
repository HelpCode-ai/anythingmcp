import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse } from 'imapflow';
import * as nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { DeploymentService } from '../../common/deployment.service';
import {
  SsrfBlockedError,
  assertSafeOutboundHost,
  resolveSafeOutboundHost,
} from '../../common/ssrf.util';
import { BINARY_MARKER, DEFAULT_MAX_BINARY_BYTES, type BinaryBody } from '../binary-response.util';
import { MimeBuildError, buildMimeMessage, parseMimeAddresses } from './mime-message.util';
import { isEmailMethod, type EmailMethod } from '../email/email-builtins';
import {
  EmailConnectorError,
  resolveEmailCredentials,
  resolveEmailSettings,
  shouldSaveSent,
  type EmailCredentials,
  type MailServer,
  type ResolvedEmailSettings,
} from '../email/email-settings';
import {
  DEFAULT_ATTACHMENT_CHARS,
  DEFAULT_BODY_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_ATTACHMENT_CHARS,
  MAX_BODY_CHARS,
  MAX_RECIPIENTS,
  MAX_SEARCH_LIMIT,
  analyseStructure,
  buildSearchQuery,
  clampInt,
  formatAddresses,
  isTextualType,
  parseFolder,
  parseUid,
  parseUids,
  replyReferences,
  replySubject,
  rfc5322Date,
  snippetOf,
  truncateText,
  type BodyPart,
} from '../email/email-message.util';

/** Connecting (DNS, TCP, TLS, greeting) gives up after this long. */
export const EMAIL_CONNECT_TIMEOUT_MS = 15_000;
/** A connection that stays silent this long is dropped. */
export const EMAIL_SOCKET_TIMEOUT_MS = 60_000;
/** Attachments above this are refused rather than downloaded. */
export const MAX_ATTACHMENT_BYTES = DEFAULT_MAX_BINARY_BYTES;
/** At most this much of a body part is downloaded. */
const MAX_BODY_DOWNLOAD_BYTES = 2 * 1024 * 1024;
/** Bytes of a body read for a search snippet. */
const SNIPPET_DOWNLOAD_BYTES = 4 * 1024;
/** Snippets are read for at most this many search results. */
const MAX_SNIPPETS = 50;
/** Folders listed with counts; a larger tree is listed without STATUS. */
const MAX_FOLDERS_WITH_COUNTS = 150;
const MAX_FOLDERS = 500;
/**
 * Bounds what one IMAP response may make us hold in memory. Downloads come in
 * 64 KB chunks, so this is far above any honest server's answer.
 */
const MAX_LITERAL_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

/** What the engine needs from imapflow; tests hand in a fake. */
export type ImapClient = Pick<
  ImapFlow,
  | 'connect'
  | 'logout'
  | 'close'
  | 'list'
  | 'getMailboxLock'
  | 'search'
  | 'fetchAll'
  | 'fetchOne'
  | 'download'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageMove'
  | 'append'
  | 'capabilities'
> & { on?: (event: 'error', listener: (err: unknown) => void) => unknown };

export interface SmtpTransport {
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: string }): Promise<unknown>;
  verify(): Promise<unknown>;
  close(): void;
}

export type ImapFactory = (options: ImapFlowOptions) => ImapClient;
export type SmtpFactory = (options: Record<string, unknown>) => SmtpTransport;

export interface EmailEngineConfig {
  /** Decrypted authConfig: username, password, smtpUsername?, smtpPassword?. */
  authConfig?: Record<string, unknown>;
  /** imaps://host:993, the fallback for a connector without config.email.imapHost. */
  baseUrl?: string;
}

interface Target {
  /** What the socket connects to: the address the SSRF guard checked, or the name. */
  host: string;
  /** TLS server name (SNI and certificate check) when host is an address. */
  servername?: string;
}

interface Composed {
  /** Sent over SMTP: no Bcc header. */
  wire: string;
  /** Filed in Sent / Drafts: with the Bcc header, so the sender sees who got a blind copy. */
  copy: string;
  messageId: string;
  envelope: { from: string; to: string[] };
  original?: { folder: string; uid: number };
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'ESOCKET',
  'ECONNECTION',
  'ETIMEOUT',
  'NoConnection',
  'GREETING_TIMEOUT',
]);

/**
 * IMAP (read, search, flag, move, draft) and SMTP (send) for EMAIL
 * connectors.
 *
 * Every call opens its own IMAP connection, does its work and logs out:
 * nothing stays connected between tool calls, so a mailbox is never held open
 * on a shared server and a changed password applies at once. Connections time
 * out after 15 s (connect) and 60 s of silence. Hosts pass the outbound SSRF
 * guard and the socket goes to the address the guard checked, with the name
 * kept for TLS. Credentials never reach a log line or an error message: the
 * clients' own loggers are off and every message is scrubbed of the passwords
 * (and their AUTH PLAIN / LOGIN encodings) before it leaves.
 */
@Injectable()
export class EmailEngine {
  private readonly logger = new Logger(EmailEngine.name);

  /** Replaced in tests. */
  imapFactory: ImapFactory = (options) => new ImapFlow(options) as unknown as ImapClient;
  smtpFactory: SmtpFactory = (options) =>
    nodemailer.createTransport(options as nodemailer.TransportOptions) as unknown as SmtpTransport;

  constructor(@Optional() private readonly deployment?: DeploymentService) {}

  private isCloud(): boolean {
    // Read per call: DEPLOYMENT_MODE is fixed in production, and tests switch it.
    return (this.deployment ?? new DeploymentService()).isCloud();
  }

  /* ---------------------------------------------------------------- */
  /*  Entry points                                                     */
  /* ---------------------------------------------------------------- */

  async execute(
    config: EmailEngineConfig,
    endpointMapping: { method: string },
    params: Record<string, unknown>,
    rawSettings: unknown,
  ): Promise<unknown> {
    const method = endpointMapping?.method;
    if (!isEmailMethod(method)) {
      throw new EmailConnectorError(
        `"${String(method).slice(0, 40)}" is not an email tool. Email connectors only run their built-in tools.`,
        'config',
      );
    }
    const settings = resolveEmailSettings(rawSettings, { cloud: this.isCloud(), baseUrl: config.baseUrl });
    const creds = resolveEmailCredentials(config.authConfig);
    const started = Date.now();
    try {
      const out = await this.dispatch(method, settings, creds, params ?? {});
      this.logger.debug(`${method} on ${settings.imap.host} took ${Date.now() - started} ms`);
      return out;
    } catch (err) {
      const safe = this.toPublicError(err, creds);
      this.logger.warn(`${method} on ${settings.imap.host} failed (${kindOf(safe)}): ${safe.message}`);
      throw safe;
    }
  }

  /** IMAP login and folder list, then SMTP login (when an SMTP server is set). */
  async testConnection(
    config: EmailEngineConfig,
    rawSettings: unknown,
  ): Promise<{ folders: number; smtp: 'ok' | 'not_configured' }> {
    const settings = resolveEmailSettings(rawSettings, { cloud: this.isCloud(), baseUrl: config.baseUrl });
    const creds = resolveEmailCredentials(config.authConfig);
    try {
      const folders = await this.withImap(settings, creds, async (client) => (await client.list()).length);
      if (!settings.smtp) return { folders, smtp: 'not_configured' };
      const transport = await this.transport(settings, creds);
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      return { folders, smtp: 'ok' };
    } catch (err) {
      const safe = this.toPublicError(err, creds);
      this.logger.warn(`Test connection to ${settings.imap.host} failed (${kindOf(safe)}): ${safe.message}`);
      throw safe;
    }
  }

  private dispatch(
    method: EmailMethod,
    settings: ResolvedEmailSettings,
    creds: EmailCredentials,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'email_list_folders':
        return this.withImap(settings, creds, (c) => this.listFolders(c));
      case 'email_search':
        return this.withImap(settings, creds, (c) => this.search(c, params));
      case 'email_get_message':
        return this.withImap(settings, creds, (c) => this.getMessage(c, params));
      case 'email_get_attachment':
        return this.withImap(settings, creds, (c) => this.getAttachment(c, params));
      case 'email_set_flags':
        return this.withImap(settings, creds, (c) => this.setFlags(c, params));
      case 'email_move':
        return this.withImap(settings, creds, (c) => this.move(c, params));
      case 'email_delete':
        return this.withImap(settings, creds, (c) => this.moveToTrash(c, settings, params));
      case 'email_save_draft':
        return this.withImap(settings, creds, (c) => this.saveDraft(c, settings, creds, params));
      case 'email_send':
        return this.send(settings, creds, params);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Connections                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * The SSRF guard, then the address to connect to. On Cloud a private,
   * loopback or link-local host is refused; self-hosted, the admin allowlist
   * (SSRF_ALLOWED_HOSTS or Admin → Settings) lets an internal mail server
   * through, and an allowlisted name is connected to by name.
   */
  private async pin(host: string): Promise<Target> {
    if (isIP(host)) {
      await assertSafeOutboundHost(host);
      return { host };
    }
    const addresses = await resolveSafeOutboundHost(host);
    const pick = addresses?.find((a) => a.family === 4) ?? addresses?.[0];
    return pick ? { host: pick.address, servername: host } : { host, servername: host };
  }

  /** Extension point: XOAUTH2 would return { user, accessToken } here. */
  private imapAuth(creds: EmailCredentials): { user: string; pass: string } {
    return { user: creds.username, pass: creds.password };
  }

  private smtpAuth(creds: EmailCredentials): { user: string; pass: string } {
    return {
      user: creds.smtpUsername || creds.username,
      pass: creds.smtpPassword || creds.password,
    };
  }

  private async withImap<T>(
    settings: ResolvedEmailSettings,
    creds: EmailCredentials,
    fn: (client: ImapClient) => Promise<T>,
  ): Promise<T> {
    const server = settings.imap;
    const target = await this.pin(server.host);
    const client = this.imapFactory({
      host: target.host,
      port: server.port,
      secure: server.security === 'tls',
      // STARTTLS is required, not opportunistic: a stripped capability would
      // otherwise send the password in clear text.
      doSTARTTLS: server.security === 'starttls' ? true : server.security === 'none' ? false : undefined,
      ...(target.servername ? { servername: target.servername } : {}),
      auth: this.imapAuth(creds),
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
      maxLiteralSize: MAX_LITERAL_BYTES,
      maxResponseSize: MAX_RESPONSE_BYTES,
      tls: { rejectUnauthorized: !settings.allowSelfSigned },
    });
    // A dropped socket also surfaces as an 'error' event; the awaited call
    // below rejects with it, so the event must not crash the process.
    client.on?.('error', () => undefined);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  private async transport(settings: ResolvedEmailSettings, creds: EmailCredentials): Promise<SmtpTransport> {
    const server = settings.smtp as MailServer;
    const target = await this.pin(server.host);
    return this.smtpFactory({
      host: target.host,
      port: server.port,
      secure: server.security === 'tls',
      requireTLS: server.security === 'starttls',
      ignoreTLS: server.security === 'none',
      ...(target.servername ? { servername: target.servername } : {}),
      auth: this.smtpAuth(creds),
      connectionTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      greetingTimeout: EMAIL_CONNECT_TIMEOUT_MS,
      socketTimeout: EMAIL_SOCKET_TIMEOUT_MS,
      tls: {
        rejectUnauthorized: !settings.allowSelfSigned,
        ...(target.servername ? { servername: target.servername } : {}),
      },
      logger: false,
      debug: false,
      // The message is built here; nodemailer must not fetch files or URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Folders                                                          */
  /* ---------------------------------------------------------------- */

  private async listFolders(client: ImapClient): Promise<unknown> {
    let list = await client.list();
    const withCounts = list.length <= MAX_FOLDERS_WITH_COUNTS;
    if (withCounts) list = await client.list({ statusQuery: { messages: true, unseen: true } });
    const folders = list
      .filter((f) => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent'))
      .slice(0, MAX_FOLDERS)
      .map((f) => ({
        path: f.path,
        name: f.name,
        role: roleOf(f.specialUse),
        ...(withCounts ? { messages: f.status?.messages, unread: f.status?.unseen } : {}),
      }));
    return {
      folders,
      count: folders.length,
      ...(list.length > MAX_FOLDERS ? { note: `Only the first ${MAX_FOLDERS} folders are listed.` } : {}),
      ...(!withCounts ? { note: 'Counts are left out for a mailbox with this many folders.' } : {}),
    };
  }

  private async specialFolder(
    client: ImapClient,
    use: '\\Sent' | '\\Drafts' | '\\Trash',
    configured: string | undefined,
  ): Promise<string | undefined> {
    if (configured) return configured;
    const list: ListResponse[] = await client.list();
    return list.find((f) => f.specialUse === use)?.path;
  }

  private async assertFolderExists(client: ImapClient, path: string): Promise<void> {
    const list = await client.list();
    const found = list.some((f) =>
      path.toUpperCase() === 'INBOX' ? f.path.toUpperCase() === 'INBOX' : f.path === path,
    );
    if (!found) {
      throw new EmailConnectorError(
        `There is no folder "${path}". Call list_folders and use a path exactly as listed.`,
        'not_found',
      );
    }
  }

  private async lock(client: ImapClient, folder: string, readOnly: boolean) {
    try {
      return await client.getMailboxLock(folder, { readOnly });
    } catch (err: any) {
      const text = String(err?.responseText ?? err?.message ?? '');
      if (err?.serverResponseCode === 'NONEXISTENT' || /doesn't exist|does not exist|nonexistent|not found|no such|unknown mailbox/i.test(text)) {
        throw new EmailConnectorError(
          `There is no folder "${folder}". Call list_folders and use a path exactly as listed.`,
          'not_found',
        );
      }
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Reading                                                          */
  /* ---------------------------------------------------------------- */

  private async search(client: ImapClient, params: Record<string, unknown>): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const query = buildSearchQuery(params);
    const limit = clampInt(params.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const snippets = params.include_snippets !== false && params.include_snippets !== 'false';
    const lock = await this.lock(client, folder, true);
    try {
      const found = (await client.search(query, { uid: true })) || [];
      // UIDs grow with arrival, so the highest are the newest.
      const uids = [...found].sort((a, b) => b - a);
      const pick = uids.slice(0, limit);
      if (pick.length === 0) return { folder, total: 0, messages: [] };
      const fetched = await client.fetchAll(
        pick,
        { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true },
        { uid: true },
      );
      fetched.sort((a, b) => dateOf(b) - dateOf(a) || b.uid - a.uid);
      const messages: Array<Record<string, unknown>> = [];
      for (const [i, msg] of fetched.entries()) {
        const parts = analyseStructure(msg.bodyStructure);
        const row: Record<string, unknown> = {
          uid: msg.uid,
          date: isoDate(msg.envelope?.date ?? msg.internalDate),
          from: formatAddresses(msg.envelope?.from).join(', '),
          to: formatAddresses(msg.envelope?.to),
          subject: msg.envelope?.subject ?? '',
          flags: [...(msg.flags ?? [])],
          unread: !msg.flags?.has('\\Seen'),
          size: msg.size,
          hasAttachments: parts.attachments.some((a) => !a.inline),
        };
        if (snippets && i < MAX_SNIPPETS) {
          const body = parts.text ?? parts.html;
          if (body) {
            const raw = await this.downloadText(client, msg.uid, body, SNIPPET_DOWNLOAD_BYTES).catch(() => '');
            const text = body === parts.text ? raw : await htmlToText(raw);
            row.snippet = snippetOf(text);
          }
        }
        messages.push(row);
      }
      return {
        folder,
        total: uids.length,
        returned: messages.length,
        ...(uids.length > messages.length
          ? { note: `${uids.length - messages.length} older matches not shown: narrow the search or raise limit (at most ${MAX_SEARCH_LIMIT}).` }
          : {}),
        messages,
      };
    } finally {
      lock.release();
    }
  }

  private async fetchMessage(client: ImapClient, folder: string, uid: number, withHeaders: boolean) {
    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
        internalDate: true,
        bodyStructure: true,
        ...(withHeaders ? { headers: ['references', 'reply-to', 'list-unsubscribe'] } : {}),
      },
      { uid: true },
    );
    if (!msg) {
      throw new EmailConnectorError(
        `No message with UID ${uid} in "${folder}". UIDs belong to one folder and change when a message is moved: search again.`,
        'not_found',
      );
    }
    return msg;
  }

  private async getMessage(client: ImapClient, params: Record<string, unknown>): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const uid = parseUid('uid', params.uid);
    const maxChars = clampInt(params.max_chars, DEFAULT_BODY_CHARS, MAX_BODY_CHARS);
    const markRead = params.mark_as_read === true || params.mark_as_read === 'true';
    const lock = await this.lock(client, folder, !markRead);
    try {
      const msg = await this.fetchMessage(client, folder, uid, true);
      const parts = analyseStructure(msg.bodyStructure);
      const headers = msg.headers ? await simpleParser(msg.headers) : undefined;

      let body: { format: string; text: string; truncated: boolean; totalChars: number } = {
        format: 'none',
        text: '',
        truncated: false,
        totalChars: 0,
      };
      if (parts.text) {
        const text = await this.downloadText(client, uid, parts.text, MAX_BODY_DOWNLOAD_BYTES);
        body = { format: 'text', ...truncateText(text, maxChars) };
      } else if (parts.html) {
        const html = await this.downloadText(client, uid, parts.html, MAX_BODY_DOWNLOAD_BYTES);
        body = { format: 'html_as_text', ...truncateText(await htmlToText(html), maxChars) };
      }
      if (markRead) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

      return {
        folder,
        uid,
        messageId: msg.envelope?.messageId,
        date: isoDate(msg.envelope?.date ?? msg.internalDate),
        from: formatAddresses(msg.envelope?.from),
        to: formatAddresses(msg.envelope?.to),
        cc: formatAddresses(msg.envelope?.cc),
        replyTo: formatAddresses(msg.envelope?.replyTo),
        subject: msg.envelope?.subject ?? '',
        inReplyTo: msg.envelope?.inReplyTo,
        references: headers?.references,
        flags: [...(msg.flags ?? [])].concat(markRead && !msg.flags?.has('\\Seen') ? ['\\Seen'] : []),
        size: msg.size,
        body,
        attachments: parts.attachments.map(({ part: _part, ...rest }) => rest),
      };
    } finally {
      lock.release();
    }
  }

  private async getAttachment(client: ImapClient, params: Record<string, unknown>): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const uid = parseUid('uid', params.uid);
    const index = parseUid('index', params.index);
    const maxChars = clampInt(params.max_chars, DEFAULT_ATTACHMENT_CHARS, MAX_ATTACHMENT_CHARS);
    const lock = await this.lock(client, folder, true);
    try {
      const msg = await this.fetchMessage(client, folder, uid, false);
      const { attachments } = analyseStructure(msg.bodyStructure);
      const att = attachments.find((a) => a.index === index);
      if (!att) {
        throw new EmailConnectorError(
          attachments.length === 0
            ? `Message ${uid} has no attachments.`
            : `Message ${uid} has ${attachments.length} attachment(s); index must be between 1 and ${attachments.length}.`,
          'not_found',
        );
      }
      if (att.approxBytes !== undefined && att.approxBytes > MAX_ATTACHMENT_BYTES * 1.05) {
        throw tooLarge(att.filename, att.approxBytes);
      }
      const buf = await this.download(client, uid, att.part, MAX_ATTACHMENT_BYTES + 1);
      if (buf.length > MAX_ATTACHMENT_BYTES) throw tooLarge(att.filename);

      if (isTextualType(att.contentType)) {
        const text = buf.toString('utf8');
        return {
          filename: att.filename,
          contentType: att.contentType,
          bytes: buf.length,
          ...truncateText(text, maxChars, 'attachment'),
        };
      }
      const file: BinaryBody = {
        [BINARY_MARKER]: 1,
        contentType: att.contentType,
        bytes: buf.length,
        filename: att.filename,
        base64: buf.toString('base64'),
      };
      return file;
    } finally {
      lock.release();
    }
  }

  private async download(client: ImapClient, uid: number, part: string, maxBytes: number): Promise<Buffer> {
    const res = await client.download(String(uid), part, { uid: true, maxBytes });
    const content = (res as { content?: Readable | null }).content;
    if (!content) {
      throw new EmailConnectorError(`Part ${part} of message ${uid} could not be read.`, 'not_found');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of content) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(b);
      total += b.length;
      if (total > maxBytes) break;
    }
    return Buffer.concat(chunks);
  }

  /** A text part, decoded to UTF-8 by imapflow, cut at maxBytes. */
  private async downloadText(client: ImapClient, uid: number, part: BodyPart, maxBytes: number): Promise<string> {
    return (await this.download(client, uid, part.part, maxBytes)).toString('utf8');
  }

  /* ---------------------------------------------------------------- */
  /*  Changing the mailbox                                             */
  /* ---------------------------------------------------------------- */

  private async setFlags(client: ImapClient, params: Record<string, unknown>): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const uids = parseUids(params.uids);
    const seen = optionalBool(params.seen);
    const flagged = optionalBool(params.flagged);
    if (seen === undefined && flagged === undefined) {
      throw new EmailConnectorError('Give seen, flagged, or both.', 'invalid_input');
    }
    const range = uids.join(',');
    const lock = await this.lock(client, folder, false);
    try {
      if (seen === true) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      if (seen === false) await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      if (flagged === true) await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
      if (flagged === false) await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
    } finally {
      lock.release();
    }
    return { folder, uids, ...(seen !== undefined ? { seen } : {}), ...(flagged !== undefined ? { flagged } : {}) };
  }

  private async move(client: ImapClient, params: Record<string, unknown>): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const uids = parseUids(params.uids);
    const destination = parseFolder('destination', params.destination, '');
    if (!destination) throw new EmailConnectorError('destination is required.', 'invalid_input');
    if (destination === folder) {
      throw new EmailConnectorError('destination is the folder the messages are already in.', 'invalid_input');
    }
    await this.assertFolderExists(client, destination);
    return this.moveTo(client, folder, uids, destination);
  }

  private async moveTo(client: ImapClient, folder: string, uids: number[], destination: string) {
    // Without MOVE, a move is COPY + \Deleted + EXPUNGE, and without UIDPLUS
    // that EXPUNGE would also remove every other message another client
    // marked as deleted in the folder. Refused rather than risked.
    const caps = client.capabilities;
    if (caps && !caps.has('MOVE') && !caps.has('UIDPLUS')) {
      throw new EmailConnectorError(
        'This mail server supports neither IMAP MOVE nor UIDPLUS, so moving a message could permanently remove other messages marked as deleted in the folder. Move it in your mail client instead.',
        'error',
      );
    }
    const lock = await this.lock(client, folder, false);
    try {
      const res = await client.messageMove(uids.join(','), destination, { uid: true });
      const map = res && res.uidMap ? Object.fromEntries(res.uidMap) : undefined;
      return { folder, destination, moved: uids.length, ...(map ? { newUids: map } : {}) };
    } finally {
      lock.release();
    }
  }

  /** Move to the Trash folder. This connector never sets \Deleted or runs EXPUNGE. */
  private async moveToTrash(
    client: ImapClient,
    settings: ResolvedEmailSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const folder = parseFolder('folder', params.folder);
    const uids = parseUids(params.uids);
    const trash = await this.specialFolder(client, '\\Trash', settings.trashFolder);
    if (!trash) {
      throw new EmailConnectorError(
        'This mailbox has no Trash folder the server marks as such. Move the messages to a folder of your choice with move_messages instead.',
        'not_found',
      );
    }
    if (trash === folder) {
      throw new EmailConnectorError(
        `The messages are already in the Trash ("${trash}"). This connector never deletes permanently; empty the Trash in your mail client.`,
        'invalid_input',
      );
    }
    const out = await this.moveTo(client, folder, uids, trash);
    return { ...out, note: 'Moved to the Trash, not deleted permanently.' };
  }

  /* ---------------------------------------------------------------- */
  /*  Writing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Build the message. A reply reads the original first (its Message-ID,
   * References, sender and subject), on the connection the caller holds.
   */
  private async compose(
    client: ImapClient | null,
    settings: ResolvedEmailSettings,
    creds: EmailCredentials,
    params: Record<string, unknown>,
  ): Promise<Composed> {
    const fromAddress = settings.fromAddress ?? (creds.username.includes('@') ? creds.username : undefined);
    if (!fromAddress) {
      throw new EmailConnectorError(
        'The connector has no sender address: set "From address" in its settings (the username is not an e-mail address).',
        'config',
      );
    }
    let to = params.to;
    let subject = typeof params.subject === 'string' && params.subject.trim() ? params.subject : undefined;
    let inReplyTo: string | undefined;
    let references: string[] = [];
    let original: Composed['original'];

    if (params.in_reply_to_uid !== undefined && params.in_reply_to_uid !== null && params.in_reply_to_uid !== '') {
      if (!client) throw new Error('A reply needs the IMAP connection.');
      const folder = parseFolder('in_reply_to_folder', params.in_reply_to_folder);
      const uid = parseUid('in_reply_to_uid', params.in_reply_to_uid);
      const lock = await this.lock(client, folder, true);
      try {
        const msg = await this.fetchMessage(client, folder, uid, true);
        const headers = msg.headers ? await simpleParser(msg.headers) : undefined;
        inReplyTo = msg.envelope?.messageId;
        references = replyReferences(headers?.references, inReplyTo);
        if (isEmpty(to)) {
          const replyTo = msg.envelope?.replyTo?.length ? msg.envelope.replyTo : msg.envelope?.from;
          // Bare addresses: a display name with a comma would split the list.
          to = (replyTo ?? []).map((a) => a.address).filter((a): a is string => !!a);
        }
        subject = subject ?? replySubject(msg.envelope?.subject);
        original = { folder, uid };
      } finally {
        lock.release();
      }
    }

    const text = typeof params.text === 'string' ? params.text : undefined;
    const html = typeof params.html === 'string' ? params.html : undefined;
    if (!text && !html) throw new EmailConnectorError('Give the message body as text, html, or both.', 'invalid_input');

    try {
      const recipients = [
        ...parseMimeAddresses('to', to),
        ...parseMimeAddresses('cc', params.cc),
        ...parseMimeAddresses('bcc', params.bcc),
      ].map((a) => a.address);
      const unique = [...new Set(recipients.map((a) => a.toLowerCase()))];
      if (unique.length === 0) throw new EmailConnectorError('Give at least one recipient in to.', 'invalid_input');
      if (unique.length > MAX_RECIPIENTS) {
        throw new EmailConnectorError(`At most ${MAX_RECIPIENTS} recipients per message.`, 'invalid_input');
      }
      const from = settings.fromName ? `${settings.fromName} <${fromAddress}>` : fromAddress;
      const spec: Record<string, unknown> = {
        from,
        to,
        cc: params.cc,
        subject: subject ?? '',
        ...(text !== undefined ? { text } : {}),
        ...(html !== undefined ? { html } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length ? { references } : {}),
      };
      const boundary = `amcp_${randomUUID().replace(/-/g, '')}`;
      const domain = fromAddress.split('@')[1] ?? 'anythingmcp.local';
      const messageId = `<${randomUUID()}@${domain}>`;
      const top = `Date: ${rfc5322Date(new Date())}\r\nMessage-ID: ${messageId}\r\n`;
      const wire = top + buildMimeMessage(spec, { boundary });
      const copy = isEmpty(params.bcc) ? wire : top + buildMimeMessage({ ...spec, bcc: params.bcc }, { boundary });
      return { wire, copy, messageId, envelope: { from: fromAddress, to: unique }, original };
    } catch (err) {
      if (err instanceof MimeBuildError) throw new EmailConnectorError(err.message, 'invalid_input');
      throw err;
    }
  }

  private async saveDraft(
    client: ImapClient,
    settings: ResolvedEmailSettings,
    creds: EmailCredentials,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const message = await this.compose(client, settings, creds, params);
    const drafts = await this.specialFolder(client, '\\Drafts', settings.draftsFolder);
    if (!drafts) {
      throw new EmailConnectorError(
        'This mailbox has no Drafts folder the server marks as such: set "Drafts folder" in the connector settings.',
        'not_found',
      );
    }
    const res = await client.append(drafts, message.copy, ['\\Draft', '\\Seen'], new Date());
    return {
      saved: true,
      folder: drafts,
      ...(res && res.uid ? { uid: res.uid } : {}),
      messageId: message.messageId,
      recipients: message.envelope.to.length,
    };
  }

  /**
   * Send through SMTP, then file a copy in Sent and mark the original of a
   * reply as answered. Once SMTP accepted the message nothing throws: a
   * failed copy is reported in the result, because the mail has left and
   * sending it again would deliver it twice.
   */
  private async send(
    settings: ResolvedEmailSettings,
    creds: EmailCredentials,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!settings.smtp) {
      throw new EmailConnectorError(
        'This connector has no SMTP server, so it cannot send. Add the SMTP host in its settings, or use save_draft.',
        'config',
      );
    }
    const isReply = !isEmpty(params.in_reply_to_uid);
    const saveCopy = shouldSaveSent(settings);

    const sendWith = async (client: ImapClient | null) => {
      const message = await this.compose(client, settings, creds, params);
      const transport = await this.transport(settings, creds);
      try {
        await transport.sendMail({ envelope: message.envelope, raw: message.wire });
      } finally {
        transport.close();
      }
      const result: Record<string, unknown> = {
        sent: true,
        messageId: message.messageId,
        recipients: message.envelope.to.length,
      };
      const warnings: string[] = [];
      if (client && saveCopy) {
        try {
          const sent = await this.specialFolder(client, '\\Sent', settings.sentFolder);
          if (sent) {
            await client.append(sent, message.copy, ['\\Seen'], new Date());
            result.savedTo = sent;
          } else {
            warnings.push('No Sent folder found, so no copy was filed. Set "Sent folder" in the connector settings.');
          }
        } catch (err) {
          warnings.push(`The message was sent, but filing a copy in Sent failed: ${this.toPublicError(err, creds).message}`);
        }
      } else if (!saveCopy) {
        result.savedTo = 'filed by the provider';
      }
      if (client && message.original) {
        try {
          const lock = await this.lock(client, message.original.folder, false);
          try {
            await client.messageFlagsAdd(String(message.original.uid), ['\\Answered'], { uid: true });
          } finally {
            lock.release();
          }
        } catch {
          // Cosmetic: the reply went out either way.
        }
      }
      if (warnings.length) result.warnings = warnings;
      return result;
    };

    // IMAP is needed for a reply (reading the original) or for the Sent copy.
    return isReply || saveCopy ? this.withImap(settings, creds, sendWith) : sendWith(null);
  }

  /* ---------------------------------------------------------------- */
  /*  Errors                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * One error type out of the engine, worded for the user, with every
   * credential removed. Kinds: auth_failed, tls, unreachable, not_found,
   * config, invalid_input, error. SSRF guard errors pass through unchanged
   * (they name a host, never a credential) so the test connection can offer
   * the allowlist.
   */
  toPublicError(err: unknown, creds?: EmailCredentials): EmailConnectorError | SsrfBlockedError {
    if (err instanceof SsrfBlockedError) return err;
    const scrub = (text: string) => redactCredentials(text, creds);
    if (err instanceof EmailConnectorError) {
      return new EmailConnectorError(scrub(err.message), err.kind);
    }
    const e = (err ?? {}) as Record<string, any>;
    const code = String(e.code ?? '');
    const detail = scrub(String(e.responseText || e.response || e.message || 'unknown error')).slice(0, 300);

    if (e.authenticationFailed || code === 'EAUTH' || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|login failed|535[ -]/i.test(detail)) {
      return new EmailConnectorError(
        `The mail server refused the login (${detail}). Check the username (usually the full e-mail address) and the password. ` +
          'Gmail, Yahoo and iCloud need an app password; Microsoft 365 and Outlook.com do not accept passwords here (use the Microsoft 365 / Outlook connectors).',
        'auth_failed',
      );
    }
    if (TLS_ERROR_CODES.has(code) || /certificate|self[- ]signed|CERT_|altnames|wrong version number|SSL routines/i.test(detail)) {
      const selfHostedHint = this.isCloud()
        ? ' The server needs a certificate from a public authority for its host name.'
        : ' For a server with a self-signed certificate on your own network, switch on "Accept self-signed certificate" in the connector settings.';
      return new EmailConnectorError(
        `The TLS connection to the mail server failed (${code || detail}). Check that the host name matches the server's certificate and that the port fits the security setting (993/465 SSL/TLS, 143/587 STARTTLS).` +
          selfHostedHint,
        'tls',
      );
    }
    if (NETWORK_ERROR_CODES.has(code) || /timed? ?out|ECONNREFUSED|ENOTFOUND|socket|connection closed|greeting/i.test(detail)) {
      return new EmailConnectorError(
        `The mail server could not be reached (${code || detail}). Check the host and port, and that the server accepts connections from this AnythingMCP server.`,
        'unreachable',
      );
    }
    return new EmailConnectorError(`The mail server answered with an error: ${detail}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function kindOf(err: EmailConnectorError | SsrfBlockedError): string {
  return err instanceof EmailConnectorError ? err.kind : 'blocked';
}

function roleOf(specialUse: string | undefined): string | undefined {
  if (!specialUse) return undefined;
  return specialUse.replace(/^\\/, '').toLowerCase();
}

function dateOf(msg: FetchMessageObject): number {
  const d = msg.internalDate ?? msg.envelope?.date;
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function isoDate(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function optionalBool(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function tooLarge(filename: string, bytes?: number): EmailConnectorError {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const size = bytes !== undefined ? `is about ${mb(bytes)}` : `is larger than ${mb(MAX_ATTACHMENT_BYTES)}`;
  return new EmailConnectorError(
    `The attachment "${filename}" ${size}, above the ${mb(MAX_ATTACHMENT_BYTES)} limit for one tool call. Open it in a mail client instead.`,
    'invalid_input',
  );
}

/** HTML body to plain text, the way mailparser renders an HTML-only message. */
export async function htmlToText(html: string): Promise<string> {
  if (!html) return '';
  const source = Buffer.concat([
    Buffer.from('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    Buffer.from(html, 'utf8'),
  ]);
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  return typeof parsed.text === 'string' ? parsed.text.trim() : '';
}

/**
 * Remove the passwords from a message, together with the forms a server could
 * echo them in: base64 of the password, and of the AUTH PLAIN blob.
 */
export function redactCredentials(text: string, creds?: EmailCredentials): string {
  if (!creds) return text;
  const secrets = new Set<string>();
  for (const [user, pass] of [
    [creds.username, creds.password],
    [creds.smtpUsername || creds.username, creds.smtpPassword || creds.password],
  ] as const) {
    if (!pass) continue;
    secrets.add(pass);
    secrets.add(Buffer.from(pass).toString('base64'));
    secrets.add(Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64'));
    secrets.add(Buffer.from(`${user}\u0000${user}\u0000${pass}`).toString('base64'));
  }
  let out = text;
  for (const s of [...secrets].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***');
  }
  return out;
}
