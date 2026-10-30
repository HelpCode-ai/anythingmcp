import { slugifyForPrefix } from '../graphql-builtins';

/**
 * Settings of an EMAIL connector (IMAP for reading, SMTP for sending).
 *
 * Where they live:
 *   - `connector.config.email`: everything that is not a secret (hosts, ports,
 *     security, from address, folders). Catalog installs keep `{{VAR}}` here
 *     and the values are resolved from the connector's variables per call,
 *     as OData settings are.
 *   - `connector.authConfig` (encrypted, `BASIC_AUTH`): `username`,
 *     `password`, and optionally `smtpUsername` / `smtpPassword` when the
 *     provider uses a different login for sending.
 *
 * Deployment rules, enforced here so the API, the engine and the test
 * connection agree:
 *   - Cloud: TLS only (implicit TLS or STARTTLS; never plaintext), the
 *     certificate is always verified, and the ports are the standard mail
 *     ports. The SSRF guard refuses private and loopback hosts (engine).
 *   - Self-hosted: plaintext and self-signed certificates may be switched on
 *     for a mail server inside the network, which the admin also allowlists
 *     for the SSRF guard.
 */

export type MailSecurity = 'tls' | 'starttls' | 'none';
export type SaveSentMode = 'auto' | 'always' | 'never';

/** What `config.email` may hold. Values arrive as strings from catalog variables. */
export interface EmailSettingsInput {
  imapHost?: unknown;
  imapPort?: unknown;
  imapSecurity?: unknown;
  smtpHost?: unknown;
  smtpPort?: unknown;
  smtpSecurity?: unknown;
  fromAddress?: unknown;
  fromName?: unknown;
  sentFolder?: unknown;
  draftsFolder?: unknown;
  trashFolder?: unknown;
  saveSent?: unknown;
  allowSelfSigned?: unknown;
  toolPrefix?: unknown;
}

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface ResolvedEmailSettings {
  imap: MailServer;
  /** Null when no SMTP host is set: reading works, sending is refused. */
  smtp: MailServer | null;
  fromAddress?: string;
  fromName?: string;
  sentFolder?: string;
  draftsFolder?: string;
  trashFolder?: string;
  saveSent: SaveSentMode;
  allowSelfSigned: boolean;
}

/**
 * How the connector signs in. Only `password` (the account or app password)
 * exists today. XOAUTH2 (Gmail and Microsoft 365 with OAuth tokens) is the
 * planned addition: it becomes a second mechanism here, and the engine's
 * `imapAuth` / `smtpAuth` hand `accessToken` instead of `pass` to the clients
 * (both imapflow and nodemailer accept it).
 */
export type EmailAuthMechanism = 'password';

export interface EmailCredentials {
  mechanism: EmailAuthMechanism;
  username: string;
  password: string;
  smtpUsername?: string;
  smtpPassword?: string;
}

export type EmailErrorKind =
  | 'config'
  | 'auth_failed'
  | 'unreachable'
  | 'tls'
  | 'not_found'
  | 'invalid_input'
  /** Cloud only: the hosting network blocks outgoing SMTP on this port. */
  | 'smtp_blocked'
  | 'error';

/**
 * Every error the email engine lets out: a message meant for the user and the
 * model (never a credential), and a kind the test connection maps onto its
 * result.
 */
export class EmailConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: EmailErrorKind = 'error',
  ) {
    super(message);
    this.name = 'EmailConnectorError';
  }
}

/**
 * Standard ports, the only ones a Cloud connector may use. Port 25 is left
 * out on purpose: it is server-to-server delivery, and mail sent straight to
 * recipients' MX hosts from the Cloud's address would put that address on
 * blocklists. Self-hosted, any port is allowed.
 */
export const CLOUD_IMAP_PORTS: ReadonlySet<number> = new Set([993, 143]);
export const CLOUD_SMTP_PORTS: ReadonlySet<number> = new Set([465, 587, 2525]);

/**
 * Submission ports the Cloud's hosting provider blocks for outgoing traffic
 * (measured on the Cloud droplet, October 2026: 25, 465 and 587 time out,
 * 2525 passes). A connection on one of them fails fast on Cloud and is
 * reported as such rather than as an unreachable server.
 */
export const CLOUD_BLOCKED_SMTP_PORTS: ReadonlySet<number> = new Set([25, 465, 587]);

export function cloudSmtpBlockedMessage(port: number): string {
  return (
    `AnythingMCP Cloud cannot send through SMTP port ${port}: the Cloud's hosting provider blocks outgoing SMTP on ports 25, 465 and 587. ` +
    'Nothing was sent. Save the message with save_draft and send it from your mail client, or use a mail provider that accepts SMTP on port 2525. ' +
    'Reading and organising mail over IMAP is not affected.'
  );
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;
// Characters that end or restructure an address in a header.
const ADDRESS_FORBIDDEN = /[\s<>()[\]",;:\\]/;

/**
 * One @, a local part, and a domain with a dot that neither starts nor ends
 * it. Checked by splitting rather than with one regular expression: the
 * pattern `x+@x+\.x+` backtracks polynomially on a long run of dots
 * (CodeQL js/polynomial-redos), and this value comes from a request body.
 */
export function isEmailAddress(value: string): boolean {
  if (value.length > 320 || ADDRESS_FORBIDDEN.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && !domain.endsWith('.');
}
const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function assertResolved(field: string, value: string | undefined): void {
  const match = value ? VARIABLE_RE.exec(value) : null;
  if (match) {
    throw new EmailConnectorError(
      `The email setting ${field} still reads {{${match[1]}}}: fill in the variable ${match[1]} on the connector page.`,
      'config',
    );
  }
}

function singleLine(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new EmailConnectorError(`The email setting ${field} must be a single line of text.`, 'config');
  }
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const t = text(value)?.toLowerCase();
  return t === 'true' || t === '1' || t === 'yes' || t === 'on';
}

/** A host name or an IP literal; anything else (a URL, a path, a credential) is refused. */
export function parseMailHost(field: string, raw: unknown): string | undefined {
  let host = text(raw);
  assertResolved(field, host);
  if (!host) return undefined;
  // Tolerate a pasted URL (imaps://imap.example.com:993) by keeping its host.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(host);
  if (scheme) host = scheme[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.length > 253 || !(HOST_RE.test(host) || (host.includes(':') && IPV6_RE.test(host)))) {
    throw new EmailConnectorError(
      `The email setting ${field} must be a server name such as imap.example.com.`,
      'config',
    );
  }
  return host.replace(/\.$/, '').toLowerCase();
}

function parsePort(field: string, raw: unknown): number | undefined {
  const value = text(raw);
  assertResolved(field, value);
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new EmailConnectorError(`The email setting ${field} must be a port number such as 993.`, 'config');
  }
  return Number(value);
}

function parseSecurity(field: string, raw: unknown): MailSecurity | undefined {
  const value = text(raw)?.toLowerCase();
  assertResolved(field, value);
  if (value === undefined) return undefined;
  if (value === 'tls' || value === 'ssl' || value === 'ssl/tls' || value === 'implicit') return 'tls';
  if (value === 'starttls') return 'starttls';
  if (value === 'none' || value === 'plain' || value === 'plaintext') return 'none';
  throw new EmailConnectorError(
    `The email setting ${field} must be "tls" (SSL/TLS) or "starttls", not "${value.slice(0, 20)}".`,
    'config',
  );
}

function folder(field: string, raw: unknown): string | undefined {
  const value = singleLine(field, text(raw));
  assertResolved(field, value);
  if (value && value.length > 255) {
    throw new EmailConnectorError(`The email setting ${field} is too long for a folder name.`, 'config');
  }
  return value;
}

function server(
  kind: 'IMAP' | 'SMTP',
  hostRaw: unknown,
  portRaw: unknown,
  securityRaw: unknown,
  cloud: boolean,
): MailServer | null {
  const prefix = kind === 'IMAP' ? 'imap' : 'smtp';
  const host = parseMailHost(`${prefix}Host`, hostRaw);
  if (!host) return null;
  const port = parsePort(`${prefix}Port`, portRaw);
  let security = parseSecurity(`${prefix}Security`, securityRaw);
  // The port says which one is meant when the security was left out.
  if (!security) {
    if (kind === 'IMAP') security = port === 143 ? 'starttls' : 'tls';
    else security = port === 587 || port === 25 || port === 2525 ? 'starttls' : 'tls';
  }
  const resolvedPort =
    port ?? (kind === 'IMAP' ? (security === 'tls' ? 993 : 143) : security === 'tls' ? 465 : 587);
  if (cloud) {
    if (security === 'none') {
      throw new EmailConnectorError(
        `${kind} without encryption is not available on AnythingMCP Cloud: the password would cross the internet in clear text. Use SSL/TLS or STARTTLS.`,
        'config',
      );
    }
    const allowed = kind === 'IMAP' ? CLOUD_IMAP_PORTS : CLOUD_SMTP_PORTS;
    if (!allowed.has(resolvedPort)) {
      throw new EmailConnectorError(
        `${kind} port ${resolvedPort} is not available on AnythingMCP Cloud. Use ${[...allowed].join(', ')}.`,
        'config',
      );
    }
  }
  return { host, port: resolvedPort, security };
}

/**
 * Read and check `config.email`. Throws EmailConnectorError (kind `config`)
 * with a message that names the setting and the fix.
 *
 * `fallbackHost`: the connector's base URL (imaps://host:993), used when the
 * settings carry no IMAP host, e.g. a connector created through the API with
 * only a base URL.
 */
export function resolveEmailSettings(
  raw: unknown,
  opts: { cloud: boolean; baseUrl?: string | null },
): ResolvedEmailSettings {
  const input: EmailSettingsInput =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as EmailSettingsInput) : {};

  let imapHost = input.imapHost;
  let imapPort = input.imapPort;
  let imapSecurity = input.imapSecurity;
  if (!text(imapHost) && opts.baseUrl) {
    const m = /^(imaps?):\/\/([^/?#:]+|\[[^\]]+\])(?::(\d+))?/i.exec(opts.baseUrl.trim());
    if (m) {
      imapHost = m[2];
      imapPort = text(imapPort) ?? m[3];
      imapSecurity = text(imapSecurity) ?? (m[1].toLowerCase() === 'imaps' ? 'tls' : 'starttls');
    }
  }
  const imap = server('IMAP', imapHost, imapPort, imapSecurity, opts.cloud);
  if (!imap) {
    throw new EmailConnectorError(
      'The email connector has no IMAP server: set imapHost (for example imap.ionos.de).',
      'config',
    );
  }
  const smtp = server('SMTP', input.smtpHost, input.smtpPort, input.smtpSecurity, opts.cloud);

  const allowSelfSigned = bool(input.allowSelfSigned);
  if (allowSelfSigned && opts.cloud) {
    throw new EmailConnectorError(
      'Accepting self-signed certificates is only available on self-hosted AnythingMCP. On Cloud the mail server needs a valid certificate.',
      'config',
    );
  }

  const fromAddress = singleLine('fromAddress', text(input.fromAddress));
  assertResolved('fromAddress', fromAddress);
  if (fromAddress && !isEmailAddress(fromAddress)) {
    throw new EmailConnectorError('The email setting fromAddress must be an e-mail address.', 'config');
  }
  const fromName = singleLine('fromName', text(input.fromName));
  assertResolved('fromName', fromName);

  const saveSentRaw = text(input.saveSent)?.toLowerCase();
  assertResolved('saveSent', saveSentRaw);
  const saveSent: SaveSentMode =
    saveSentRaw === 'always' || saveSentRaw === 'never' ? saveSentRaw : 'auto';

  return {
    imap,
    smtp,
    fromAddress,
    fromName: fromName?.slice(0, 200),
    sentFolder: folder('sentFolder', input.sentFolder),
    draftsFolder: folder('draftsFolder', input.draftsFolder),
    trashFolder: folder('trashFolder', input.trashFolder),
    saveSent,
    allowSelfSigned,
  };
}

/**
 * The login from the decrypted authConfig. The password is never part of a
 * message this throws.
 */
export function resolveEmailCredentials(authConfig: unknown): EmailCredentials {
  const cfg =
    authConfig && typeof authConfig === 'object' && !Array.isArray(authConfig)
      ? (authConfig as Record<string, unknown>)
      : {};
  const mechanism = text(cfg.mechanism)?.toLowerCase() ?? 'password';
  if (mechanism !== 'password') {
    throw new EmailConnectorError(
      `Sign-in method "${mechanism.slice(0, 20)}" is not supported yet: use the account password or an app password.`,
      'config',
    );
  }
  const username = text(cfg.username);
  const password = typeof cfg.password === 'string' ? cfg.password : undefined;
  assertResolved('username', username);
  if (!username || !password) {
    throw new EmailConnectorError(
      'The email connector has no login: set the username (usually the full e-mail address) and the password on the connector page.',
      'config',
    );
  }
  if (VARIABLE_RE.test(password)) {
    throw new EmailConnectorError(
      'The email password still reads {{...}}: fill in the password variable on the connector page.',
      'config',
    );
  }
  const smtpUsername = text(cfg.smtpUsername);
  const smtpPassword =
    typeof cfg.smtpPassword === 'string' && cfg.smtpPassword ? cfg.smtpPassword : undefined;
  assertResolved('smtpUsername', smtpUsername);
  return { mechanism: 'password', username, password, smtpUsername, smtpPassword };
}

/** Tool name prefix: `config.email.toolPrefix`, else derived from the connector name. */
export function emailToolPrefix(opts: { toolPrefix?: unknown; name: string }): string {
  const own = typeof opts.toolPrefix === 'string' ? opts.toolPrefix.trim() : '';
  if (own && /^[a-z][a-z0-9_]{0,39}$/.test(own)) return own;
  const base = slugifyForPrefix(opts.name).slice(0, 40).replace(/_+$/, '');
  return /mail/.test(base) ? base : `${base}_mail`;
}

/** Whether the provider files a copy of every message sent through its SMTP server itself. */
export function providerSavesSent(smtpHost: string | undefined): boolean {
  if (!smtpHost) return false;
  const host = smtpHost.toLowerCase();
  // Gmail and Google Workspace: anything sent through smtp.gmail.com lands
  // in "Sent Mail" by itself; an APPEND would file it twice.
  return host === 'smtp.gmail.com' || host === 'smtp.googlemail.com' || host === 'smtp-relay.gmail.com';
}

/** Whether a copy goes to the Sent folder after sending. */
export function shouldSaveSent(settings: ResolvedEmailSettings): boolean {
  if (settings.saveSent === 'always') return true;
  if (settings.saveSent === 'never') return false;
  return !providerSavesSent(settings.smtp?.host);
}
