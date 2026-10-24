/**
 * Secret-looking literals in URLs, paths, query parameters and headers.
 *
 * A connector built by hand put a Telegram bot token straight into its request
 * path (`https://api.telegram.org/bot<TOKEN>/sendMessage`, which is how
 * Telegram's own docs write it). From there the token reached the stored base
 * URL and tool paths in plain text, the tool names generated from the path
 * (shown to the AI client and written to logs), and anything that echoes a
 * URL. Credentials belong in the connector's encrypted variables, referenced
 * as `{{VAR}}`; this module finds the ones that were typed in literally.
 *
 * Precision over recall: a false positive moves an ordinary id into a
 * variable, or refuses a chat setting, so every rule is narrow. The whole
 * catalog (every adapter's base URL, paths, query parameters and headers) is
 * a negative test case: see secret-literals.util.spec.ts.
 *
 * Everything here works on user input, so no pattern may backtrack
 * polynomially (CodeQL js/polynomial-redos): each one is a bounded run of a
 * single character class, and inputs are capped at MAX_SCAN_LENGTH.
 */

export type SecretKind =
  | 'telegram_bot_token'
  | 'known_prefix'
  | 'jwt'
  | 'secret_query_param'
  | 'credential_header'
  | 'high_entropy';

export interface SecretFinding {
  kind: SecretKind;
  /** The literal secret. Never log or return it; use `pattern` instead. */
  value: string;
  /** Offsets of `value` in the scanned string. */
  start: number;
  end: number;
  /**
   * A redacted description that is safe to show and log: the kind and only
   * the public part of the shape, e.g. `bot<9 digits>:***(35)`,
   * `sk_live_***(24)`, `api_key=***(32)`. Never contains secret characters.
   */
  pattern: string;
  /** The vendor prefix or parameter/header name that triggered the rule. */
  label: string;
}

/** Longer inputs are scanned up to here; a URL or header is never this long. */
const MAX_SCAN_LENGTH = 8192;

/** Replaces `{{VAR}}`, `${VAR}` and `{param}` with filler so they never match. */
const FILLER = '\u0000';

/**
 * The string with every placeholder blanked out, offsets preserved. A
 * placeholder is not a literal, whatever its name looks like.
 */
function maskPlaceholders(text: string): string {
  return text
    .replace(/\{\{[^{}]*\}\}/g, (m) => FILLER.repeat(m.length))
    .replace(/\$\{[^{}]*\}/g, (m) => FILLER.repeat(m.length))
    .replace(/\{[^{}]*\}/g, (m) => FILLER.repeat(m.length));
}

function hasPlaceholder(text: string): boolean {
  return text.includes('{{') || text.includes('${') || /^\$\w/.test(text);
}

function classes(value: string): { upper: number; lower: number; digit: number } {
  let upper = 0;
  let lower = 0;
  let digit = 0;
  for (const ch of value) {
    if (ch >= 'A' && ch <= 'Z') upper++;
    else if (ch >= 'a' && ch <= 'z') lower++;
    else if (ch >= '0' && ch <= '9') digit++;
  }
  return { upper, lower, digit };
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;

/**
 * A long, random-looking token: the last-resort rule for secrets without a
 * known shape (Discord and Zapier webhook tokens, a vendor's opaque key).
 *
 * Deliberately strict, because REST ids look random too:
 *   - 32+ characters from the base64url alphabet only (no dots, so file
 *     names and host names never qualify);
 *   - upper case, lower case and digits, at least two of each: UUIDs and
 *     hashes (hex, a single case) never pass, nor do snake_case or
 *     kebab-case words;
 *   - few separators: a slug-like value with many `-`/`_` is words;
 *   - at least 4.2 bits of entropy per character: camelCase identifiers
 *     with a version number sit around 3.5–4.0, random keys above 4.5.
 * A base62 document id of 32+ characters (some Google Drive ids) can still
 * pass. Moving one into a variable keeps it working, it only reads oddly.
 */
export function looksHighEntropy(token: string): boolean {
  if (token.length < 32 || token.length > 512) return false;
  if (!/^[A-Za-z0-9_\-+]+$/.test(token)) return false;
  if (UUID.test(token) || HEX.test(token)) return false;
  const { upper, lower, digit } = classes(token);
  if (upper < 2 || lower < 2 || digit < 2) return false;
  const separators = token.length - upper - lower - digit;
  if (separators / token.length > 0.1) return false;
  // Random characters switch class (upper, lower, digit) at about 60% of
  // positions; camelCase words only at their boundaries, around 35%.
  if (classTransitions(token) / (token.length - 1) < 0.45) return false;
  return shannonEntropy(token) >= 4.2;
}

/**
 * Path segments after which a random-looking segment is a resource id, not a
 * key: `/spreadsheets/<id>`, `/document/d/<id>`, `/drive/v3/files/<id>`,
 * `/drives/b!<id>`, `/me/messages/<id>`. Google and Microsoft document,
 * file and message ids are 33–100 random base64url characters and pass the
 * entropy test; moving one into a (masked) variable hid it in the editor and
 * redacted every response that echoes it (the Sheets API returns its
 * `spreadsheetId` on each call), which breaks the next call that uses it.
 */
const ID_COLLECTIONS = new Set([
  'spreadsheets',
  'd',
  'document',
  'documents',
  'presentation',
  'presentations',
  'file',
  'files',
  'folders',
  'drives',
  'items',
  'children',
  'forms',
  'playlists',
  'videos',
  'channels',
  'messages',
  'mailfolders',
  'events',
  'calendars',
  'threads',
  'drafts',
  'attachments',
  'sites',
  'lists',
]);

/** True when the segment holding `start` comes right after one of ID_COLLECTIONS. */
function followsIdCollection(path: string, start: number): boolean {
  const segmentStart = path.lastIndexOf('/', start - 1);
  if (segmentStart <= 0) return false;
  const previousStart = path.lastIndexOf('/', segmentStart - 1);
  const previous = path.slice(previousStart + 1, segmentStart).toLowerCase();
  return ID_COLLECTIONS.has(previous);
}

function charClass(ch: string): number {
  if (ch >= 'A' && ch <= 'Z') return 1;
  if (ch >= 'a' && ch <= 'z') return 2;
  if (ch >= '0' && ch <= '9') return 3;
  return 4;
}

function classTransitions(token: string): number {
  let n = 0;
  for (let i = 1; i < token.length; i++) {
    if (charClass(token[i]) !== charClass(token[i - 1])) n++;
  }
  return n;
}

/** Mixed case and digits: a key, not a word or a slug. */
function isMixed(value: string): boolean {
  const { upper, lower, digit } = classes(value);
  return upper > 0 && lower > 0 && digit > 0;
}

interface PrefixRule {
  label: string;
  re: RegExp;
  /** Extra check on the whole match (precision). */
  accept?: (match: string) => boolean;
}

/**
 * Well-known vendor key formats. Each needs the vendor prefix after a
 * non-alphanumeric character (or at the start) and a long tail, so `/desk-…`
 * or a `sk-SK` locale never match.
 */
const PREFIX_RULES: PrefixRule[] = [
  // OpenAI / Anthropic style: sk-…, sk-proj-…, sk-ant-api03-…
  {
    label: 'sk-',
    re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9_-])/g,
    accept: (m) => isMixed(m.slice(3)),
  },
  // Stripe secret and restricted keys (live and test).
  { label: 'sk_live_', re: /(?<![A-Za-z0-9])sk_live_[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g },
  { label: 'sk_test_', re: /(?<![A-Za-z0-9])sk_test_[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g },
  { label: 'rk_live_', re: /(?<![A-Za-z0-9])rk_live_[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g },
  { label: 'rk_test_', re: /(?<![A-Za-z0-9])rk_test_[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g },
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
  { label: 'ghp_', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,255}(?![A-Za-z0-9])/g },
  { label: 'github_pat_', re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,255}(?![A-Za-z0-9_])/g },
  // Slack bot, app-level and user tokens.
  { label: 'xox-', re: /(?<![A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,255}(?![A-Za-z0-9-])/g },
  // Google API keys: AIza + 35 characters.
  { label: 'AIza', re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  // Meta (Facebook, Instagram, WhatsApp) access tokens: EAA + a long tail.
  { label: 'EAA', re: /(?<![A-Za-z0-9])EAA[A-Za-z0-9]{60,1024}(?![A-Za-z0-9])/g },
  // Shopify admin, custom app, partner and shared-secret tokens.
  { label: 'shpat_', re: /(?<![A-Za-z0-9])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g },
  // GitLab personal access tokens.
  { label: 'glpat-', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g },
];

/** Telegram bot token: `<bot id>:<35-ish chars>`, usually after `bot` in the path. */
const TELEGRAM = /(?<![A-Za-z0-9])(?:bot)?(\d{6,12}:[A-Za-z0-9_-]{30,64})(?![A-Za-z0-9_-])/g;

/** A JWT: header and payload are base64url JSON, so both start with `eyJ`. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,4096}\.eyJ[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{0,2048}/g;

/**
 * Query parameter names whose value is a credential, compared lower-case
 * with `-` and `_` removed (`api_key`, `api-key`, `apiKey` are one name).
 */
const SECRET_QUERY_NAMES = new Set([
  'key',
  'apikey',
  'xapikey',
  'apitoken',
  'token',
  'accesstoken',
  'authtoken',
  'privatetoken',
  'secret',
  'apisecret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'signature',
  'sig',
]);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

export function isSecretQueryName(name: string): boolean {
  return SECRET_QUERY_NAMES.has(normalizeName(name));
}

/** Example values from docs, not credentials: `YOUR_API_KEY`, `<token>`, `xxxx`. */
const EXAMPLE_VALUE = /^(?:your|my|insert|enter|replace|example|sample|test|dummy|placeholder|changeme|xxx)|^[<[(*x]|^(.)\1+$/i;

/**
 * Whether a literal sitting in a credential slot (a `?api_key=` value, an
 * `X-Api-Key` header) is a real secret rather than an example or a word.
 * Needs 8+ characters without spaces and something a word does not have:
 * a digit, mixed case, or 16+ characters.
 */
export function isCredentialLiteral(value: string): boolean {
  const v = value.trim();
  if (v.length < 8 || /\s/.test(v)) return false;
  if (hasPlaceholder(v) || v.includes(FILLER)) return false;
  if (EXAMPLE_VALUE.test(v)) return false;
  // A value that is itself a URL or a path is an address, not a key.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith('/')) return false;
  const { upper, lower, digit } = classes(v);
  return digit > 0 || (upper > 0 && lower > 0) || v.length >= 16;
}

function redactShape(kind: SecretKind, value: string, label: string): string {
  const n = value.length;
  switch (kind) {
    case 'telegram_bot_token': {
      const colon = value.indexOf(':');
      return `bot<${colon} digits>:***(${n - colon - 1})`;
    }
    case 'known_prefix':
      return `${label}***(${n})`;
    case 'jwt':
      return `eyJ***.eyJ***.***(${n})`;
    case 'secret_query_param':
      return `${label}=***(${n})`;
    case 'credential_header':
      return `${label}: ***(${n})`;
    case 'high_entropy':
    default:
      return `***(${n} chars, high-entropy)`;
  }
}

function finding(
  kind: SecretKind,
  text: string,
  start: number,
  end: number,
  label: string,
): SecretFinding {
  const value = text.slice(start, end);
  return { kind, value, start, end, label, pattern: redactShape(kind, value, label) };
}

/** Keeps the first of overlapping findings, earlier and longer first. */
function dedupe(findings: SecretFinding[]): SecretFinding[] {
  const sorted = [...findings].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const out: SecretFinding[] = [];
  let reach = -1;
  for (const f of sorted) {
    if (f.start < reach) continue;
    out.push(f);
    reach = f.end;
  }
  return out;
}

export interface FindOptions {
  /** Include the high-entropy heuristic (default true). */
  highEntropy?: boolean;
  /** Scan `?a=b&c=d` pairs for credential parameter names (default true). */
  query?: boolean;
}

/**
 * Secret literals in a URL, a path or any free text. Placeholders
 * (`{{VAR}}`, `${VAR}`, `{param}`) are never reported.
 */
export function findSecretLiterals(input: string, opts: FindOptions = {}): SecretFinding[] {
  if (typeof input !== 'string' || input.length < 8) return [];
  const text = input.length > MAX_SCAN_LENGTH ? input.slice(0, MAX_SCAN_LENGTH) : input;
  const masked = maskPlaceholders(text);
  const found: SecretFinding[] = [];

  for (const m of masked.matchAll(TELEGRAM)) {
    // Without `bot` in front, `<digits>:<word>` is also an AWS ARN tail
    // (`…:123456789012:my-long-topic-name`): require a random-looking secret.
    if (!m[0].startsWith('bot') && !isMixed(m[1].slice(m[1].indexOf(':') + 1))) continue;
    const start = (m.index ?? 0) + m[0].length - m[1].length;
    found.push(finding('telegram_bot_token', text, start, start + m[1].length, 'bot'));
  }
  for (const rule of PREFIX_RULES) {
    for (const m of masked.matchAll(rule.re)) {
      if (rule.accept && !rule.accept(m[0])) continue;
      const start = m.index ?? 0;
      found.push(finding('known_prefix', text, start, start + m[0].length, rule.label));
    }
  }
  for (const m of masked.matchAll(JWT)) {
    const start = m.index ?? 0;
    found.push(finding('jwt', text, start, start + m[0].length, 'jwt'));
  }

  if (opts.query !== false) {
    // `?name=value` / `&name=value` pairs; the name decides.
    for (const m of masked.matchAll(/[?&;]([^=&#?;\s]{1,64})=([^&#;\s]{0,2048})/g)) {
      const [, name, rawValue] = m;
      if (name.includes(FILLER) || !isSecretQueryName(name) || !rawValue) continue;
      const start = (m.index ?? 0) + m[0].length - rawValue.length;
      const value = text.slice(start, start + rawValue.length);
      if (!isCredentialLiteral(value)) continue;
      found.push(finding('secret_query_param', text, start, start + rawValue.length, name));
    }
  }

  if (opts.highEntropy !== false) {
    // Path only: query values are judged by their parameter's name above.
    // Ad-click ids (`gclid=Cj0KCQjw…`) and signed state look just as random
    // and are not credentials.
    const queryAt = masked.search(/[?#]/);
    const pathEnd = queryAt === -1 ? masked.length : queryAt;
    for (const m of masked.slice(0, pathEnd).matchAll(/[A-Za-z0-9_\-+]{32,512}/g)) {
      const start = m.index ?? 0;
      const before = start > 0 ? masked[start - 1] : '';
      const after = masked[start + m[0].length] ?? '';
      // Part of a dotted name (host, file) or of a longer token: not a segment.
      if (before === '.' || after === '.') continue;
      if (followsIdCollection(masked, start)) continue;
      if (!looksHighEntropy(m[0])) continue;
      found.push(finding('high_entropy', text, start, start + m[0].length, 'high-entropy'));
    }
  }

  return dedupe(found);
}

/**
 * A secret in a structured query parameter (`endpointMapping.queryParams`):
 * a credential name with a literal value, or a literal of a known shape.
 * `$param` and `{{VAR}}` values are references, never literals.
 */
export function findSecretInQueryParam(name: string, value: unknown): SecretFinding[] {
  if (typeof value !== 'string' || !value || hasPlaceholder(value)) return [];
  if (isSecretQueryName(name) && isCredentialLiteral(value)) {
    return [finding('secret_query_param', value, 0, value.length, name)];
  }
  return findSecretLiterals(value, { query: false });
}

/** HTTP auth schemes kept in front of the variable: `Bearer {{TOKEN}}`. */
const AUTH_SCHEME = /^(Bearer|Basic|Token|Bot|ApiKey|Api-Key|Key|OAuth|SSWS|Digest)\s+(\S+)$/i;

/** Header names that carry a credential (beyond those isSecretName knows). */
const CREDENTIAL_HEADER_WORDS = /(^|[-_])(authorization|auth|token|key|apikey|api-key|secret|password|signature|session|cookie)([-_]|$)/i;

/** Headers named like credentials that hold an id or a version, not a secret. */
const NOT_CREDENTIAL_HEADER = /(^|[-_])(id|version|type|name|account|tenant|user|client-id|key-id)$/i;

export function isCredentialHeaderName(name: string): boolean {
  if (NOT_CREDENTIAL_HEADER.test(name)) return false;
  return CREDENTIAL_HEADER_WORDS.test(name);
}

/**
 * A secret in a header value: a credential-named header with a literal value
 * (after its auth scheme, if any), or a literal of a known shape in any
 * header. The high-entropy rule is not used for headers: ETags, request ids
 * and signatures of public payloads look random too.
 */
export function findSecretInHeader(name: string, value: unknown): SecretFinding[] {
  if (typeof value !== 'string' || !value || hasPlaceholder(value)) return [];
  if (isCredentialHeaderName(name)) {
    const scheme = AUTH_SCHEME.exec(value.trim());
    const offset = value.indexOf(value.trim());
    const secret = scheme ? scheme[2] : value.trim();
    const start = scheme ? offset + value.trim().lastIndexOf(secret) : offset;
    if (isCredentialLiteral(secret) || findSecretLiterals(secret, { query: false }).length > 0) {
      return [finding('credential_header', value, start, start + secret.length, name)];
    }
  }
  return findSecretLiterals(value, { highEntropy: false, query: false });
}

export interface RedactOptions {
  /**
   * Also redact literals of a secret shape (default true). Off, only the
   * given values are replaced: cheap enough for a whole API response, and
   * it leaves the response's own ids and tokens alone.
   */
  patterns?: boolean;
  /** What a secret is replaced with (default `[REDACTED]`). */
  marker?: string;
}

/**
 * The text with every secret literal, and every one of `extraValues` (a
 * connector's own credentials, 6+ characters), replaced by `[REDACTED]`
 * (or `opts.marker`).
 */
export function redactSecretLiterals(
  text: string,
  extraValues: Iterable<string> = [],
  opts: RedactOptions = {},
): string {
  if (typeof text !== 'string' || !text) return text;
  const marker = opts.marker ?? '[REDACTED]';
  let out = text;
  for (const value of [...extraValues].filter((v) => typeof v === 'string' && v.length >= 6)
    .sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join(marker);
  }
  if (opts.patterns === false) return out;
  const findings = findSecretLiterals(out);
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, f.start)}${marker}${out.slice(f.end)}`;
  }
  return out;
}

/** Deep copy of `value` with secrets redacted in every string. */
export function redactSecretsDeep<T>(
  value: T,
  extraValues: Iterable<string> = [],
  opts: RedactOptions = {},
): T {
  const extras = [...extraValues].filter((v) => typeof v === 'string' && v.length >= 6);
  // Only arrays and plain objects are walked: a Date, a Buffer or a Decimal
  // (database rows) is passed through as it is, never flattened into `{}`.
  const walkable = (v: unknown): v is Record<string, unknown> => {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return true;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };
  if (opts.patterns === false) {
    // A response is usually large and clean: look before copying it.
    if (extras.length === 0) return value;
    const mentions = (v: unknown, depth: number): boolean => {
      if (typeof v === 'string') return extras.some((s) => v.includes(s));
      if (depth > 20 || !walkable(v)) return false;
      return Object.values(v).some((x) => mentions(x, depth + 1));
    };
    if (!mentions(value, 0)) return value;
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactSecretLiterals(v, extras, opts);
    if (depth > 20 || !walkable(v)) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]),
    );
  };
  return walk(value, 0) as T;
}
