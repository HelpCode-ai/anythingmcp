/**
 * File Search (#1379): shared types and constants.
 *
 * A FILE_SEARCH connector points at a folder (SFTP, FTP/FTPS, WebDAV, a
 * mounted folder). The worker (ee/file-search) indexes it into the file_*
 * tables; the MCP tools in this module only read that index. This file is
 * imported by both sides, so it holds no Nest or Prisma code.
 */

export const FILE_SEARCH_PROTOCOLS = ['sftp', 'ftp', 'ftps', 'ftps-implicit', 'webdav', 'local', 's3'] as const;
export type FileSearchProtocol = (typeof FILE_SEARCH_PROTOCOLS)[number];

/** Protocols the Cloud accepts. `local` reads a folder mounted into a self-hosted install. */
export const CLOUD_PROTOCOLS: ReadonlySet<FileSearchProtocol> = new Set(['sftp', 'ftp', 'ftps', 'ftps-implicit', 'webdav', 's3']);

export const DEFAULT_PORTS: Record<FileSearchProtocol, number | null> = {
  sftp: 22,
  ftp: 21,
  ftps: 21,
  'ftps-implicit': 990,
  webdav: 443,
  local: null,
  s3: 443,
};

/**
 * Connector settings, stored in `connector.config.fileSearch`. Secrets
 * (password, private key, passphrase, S3 secret) live in the encrypted
 * `authConfig`, never here.
 */
export interface FileSearchConfig {
  protocol: FileSearchProtocol;
  /** Host name or IP (remote protocols). For webdav and s3 the full base URL goes in `url`. */
  host?: string;
  port?: number;
  /** WebDAV base URL (https://cloud.example.com/remote.php/dav/files/user/) or S3 endpoint. */
  url?: string;
  username?: string;
  /** Folder to index, relative to the account's root (remote) or absolute below FILE_SOURCE_ROOTS (local). */
  rootPath: string;
  /** S3 bucket and region. */
  bucket?: string;
  region?: string;
  /** Globs relative to rootPath; a file is indexed when it matches one include and no exclude. */
  include: string[];
  exclude: string[];
  /** Only files changed in the last N years (0 = all). */
  maxAgeYears?: number;
  /** Extensions to index (lower case, with dot); empty = every supported one. */
  extensions?: string[];
  maxDepth: number;
  maxConnections: number;
  /** SHA-256 of the SSH host key (base64, as `ssh-keygen -l` prints it) or of the TLS certificate (hex). */
  hostKeySha256?: string;
  tlsFingerprintSha256?: string;
  /** Plain FTP sends the password unencrypted; the admin must acknowledge it. */
  allowPlainFtp?: boolean;
  /** OCR for scanned pages (Enterprise). */
  ocr?: boolean;
  toolPrefix: string;
}

/** Setup and sync states of a file source (file_sources.setup_state). */
export const FILE_SOURCE_STATES = [
  'draft',
  'active',
  'syncing',
  'paused_quota',
  'paused_licence',
  'paused_error',
  'paused_admin',
] as const;
export type FileSourceState = (typeof FILE_SOURCE_STATES)[number];

export function isPausedState(state: string): boolean {
  return state.startsWith('paused_');
}

/** Status of one file in the index (file_entries.status). */
export type FileEntryStatus = 'pending' | 'indexed' | 'name_only' | 'skipped_size' | 'failed' | 'gave_up';

/** Configuration, data and source-code files the extractor reads as text. */
export const CODE_EXTENSIONS = [
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.sql', '.tex', '.bib',
  '.srt', '.vtt', '.ics', '.vcf', '.kml', '.gpx',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.kts', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cs', '.go', '.rb', '.php', '.sh', '.bash', '.ps1', '.bat', '.cmd',
  '.swift', '.rs', '.r', '.scala', '.vb', '.vbs', '.pl', '.lua', '.css', '.scss', '.less',
  '.sass', '.gradle', '.groovy', '.dart', '.m', '.asm',
] as const;

/**
 * Extensions whose text the extractor reads (deploy/ee/file-extractor, its
 * GET /formats). Every other file is still listed and found by name
 * (`name_only`).
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.xps', '.oxps',
  '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xls', '.ods', '.ots', '.csv', '.tsv', '.numbers',
  '.docx', '.docm', '.dotx', '.dotm', '.doc', '.odt', '.ott', '.rtf', '.pages', '.epub',
  '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.ppt', '.odp', '.otp', '.key',
  '.msg', '.eml', '.mbox',
  '.txt', '.md', '.json', '.xml', '.log', '.html', '.htm',
  '.svg', '.dxf',
  ...CODE_EXTENSIONS,
]);

/**
 * Files `_view_page` shows as a picture (the extractor's POST /render): PDF
 * pages and images. Must match RENDER_EXTENSIONS in deploy/ee/file-extractor.
 */
export const VIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp',
]);

/** Human labels for the type breakdown in the wizard. */
export const TYPE_GROUPS: Record<string, string> = {
  '.pdf': 'PDF', '.xps': 'XPS', '.oxps': 'XPS',
  '.xlsx': 'Excel', '.xlsm': 'Excel', '.xltx': 'Excel', '.xltm': 'Excel', '.xlsb': 'Excel', '.xls': 'Excel',
  '.ods': 'Excel', '.ots': 'Excel', '.numbers': 'Excel', '.csv': 'CSV', '.tsv': 'CSV',
  '.docx': 'Word', '.docm': 'Word', '.dotx': 'Word', '.dotm': 'Word', '.doc': 'Word', '.odt': 'Word', '.ott': 'Word',
  '.rtf': 'Word', '.pages': 'Word', '.epub': 'E-book',
  '.pptx': 'PowerPoint', '.pptm': 'PowerPoint', '.ppsx': 'PowerPoint', '.ppsm': 'PowerPoint', '.potx': 'PowerPoint',
  '.potm': 'PowerPoint', '.ppt': 'PowerPoint', '.odp': 'PowerPoint', '.otp': 'PowerPoint', '.key': 'PowerPoint',
  '.msg': 'Outlook', '.eml': 'E-mail', '.mbox': 'E-mail',
  '.txt': 'Text', '.md': 'Text', '.json': 'Text', '.xml': 'Text', '.log': 'Text', '.html': 'Web page', '.htm': 'Web page',
  '.svg': 'Drawing', '.dxf': 'Drawing',
  ...Object.fromEntries(CODE_EXTENSIONS.map((ext) => [ext, 'Code'])),
};

/**
 * Folder and file names that are almost never worth indexing: archives of
 * old versions, NAS and OS housekeeping, Office lock files. The scan unticks
 * them as suggestions; nothing is excluded without the admin seeing it.
 */
export const ARCHIVE_FOLDER_PATTERNS = [/^alt$/i, /^alte$/i, /^old$/i, /^archiv/i, /^archive/i, /^backup/i, /^bak$/i, /^vecchi/i, /^obsolete/i, /^deprecated/i];
export const JUNK_NAMES = [/^~\$/, /^\._/, /^thumbs\.db$/i, /^desktop\.ini$/i, /^\.ds_store$/i, /^@eadir$/i, /^#recycle$/i, /^\$recycle\.bin$/i, /^\.git$/i, /^\.svn$/i, /^lost\+found$/i];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i).toLowerCase();
}

export function isJunkName(name: string): boolean {
  return JUNK_NAMES.some((re) => re.test(name));
}

export function isArchiveFolderName(name: string): boolean {
  return ARCHIVE_FOLDER_PATTERNS.some((re) => re.test(name.trim()));
}

/** What the worker's /internal/test answers, step by step (wizard step 2). */
export interface FileSourceTestStep {
  key: 'resolve' | 'connect' | 'handshake' | 'fingerprint' | 'login' | 'folder';
  ok: boolean;
  detail?: string;
}

export interface FileSourceTestResult {
  ok: boolean;
  steps: FileSourceTestStep[];
  /** Fingerprint the server presented (to confirm), when the protocol has one. */
  fingerprint?: { kind: 'ssh-host-key' | 'tls-certificate'; sha256: string; algorithm?: string };
  /** Entries in the root folder, when listing worked. */
  rootEntries?: number;
  sample?: string[];
  /** Machine-readable failure, mapped to plain words in the UI. */
  errorKind?:
    | 'dns'
    | 'unreachable'
    | 'timeout'
    | 'private_address'
    | 'tls'
    | 'fingerprint_mismatch'
    | 'fingerprint_unconfirmed'
    | 'auth'
    | 'not_found'
    | 'permission'
    | 'plain_ftp_unacknowledged'
    | 'protocol_not_allowed'
    | 'root_not_allowed'
    | 'unknown';
  message?: string;
}

/** Plan limits for File Search (see file-search-quotas.ts). */
export interface FileSearchQuota {
  plan: string;
  maxConnectors: number | null;
  maxFiles: number | null;
  maxSourceBytes: number | null;
  maxTextChars: number | null;
  maxFileBytes: number;
  minIntervalMinutes: number;
  manualSyncsPerDay: number | null;
  share: FileShareQuota | null;
  ocr: boolean;
  folderRules: boolean;
  policy: boolean;
}

export interface FileShareQuota {
  maxTtlHours: number | null;
  maxStoredBytes: number | null;
  maxFileBytes: number;
  maxLinksPerDay: number | null;
  publicLinks: boolean;
  /** Internal links may have no expiry (self-hosted Enterprise). */
  internalWithoutExpiry: boolean;
}
