import { z } from 'zod';
import {
  CLOUD_PROTOCOLS,
  DEFAULT_PORTS,
  FILE_SEARCH_PROTOCOLS,
  type FileSearchConfig,
  type FileSearchProtocol,
} from './file-search.types';

/**
 * Parsing and validation of `connector.config.fileSearch`. One place, used by
 * the wizard API, the tools and the worker, so a setting the worker would
 * refuse is refused at save time with the same words.
 */

export class FileSearchConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'FileSearchConfigError';
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i;
const PREFIX_RE = /^[a-z][a-z0-9_]{1,30}$/;

const schema = z.object({
  protocol: z.enum(FILE_SEARCH_PROTOCOLS),
  host: z.string().trim().max(253).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  url: z.string().trim().max(2048).optional(),
  username: z.string().max(256).optional(),
  rootPath: z.string().trim().max(1024).default('/'),
  bucket: z.string().trim().max(255).optional(),
  region: z.string().trim().max(64).optional(),
  include: z.array(z.string().max(512)).max(200).default(['**/*']),
  exclude: z.array(z.string().max(512)).max(500).default([]),
  maxAgeYears: z.coerce.number().int().min(0).max(100).optional(),
  extensions: z.array(z.string().max(16)).max(64).optional(),
  maxDepth: z.coerce.number().int().min(1).max(64).default(32),
  maxConnections: z.coerce.number().int().min(1).max(4).default(1),
  hostKeySha256: z.string().max(128).optional(),
  tlsFingerprintSha256: z.string().max(128).optional(),
  allowPlainFtp: z.boolean().optional(),
  ocr: z.boolean().optional(),
  toolPrefix: z.string().trim().max(31).optional(),
});

/** Turns a connector name into a tool prefix: "Supplier price lists" → "supplier_price_lists". */
export function toolPrefixFrom(name: string): string {
  const base = (name || 'files')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const withLetter = /^[a-z]/.test(base) ? base : `files_${base}`;
  return withLetter.replace(/_+$/g, '').slice(0, 30) || 'files';
}

/** Normalises a relative folder path: forward slashes, no `..`, no NUL, no trailing slash (except root). */
export function normalizeRelPath(p: string): string {
  if (p.includes('\0')) throw new FileSearchConfigError('The path contains a NUL character.', 'rootPath');
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new FileSearchConfigError('The path must not contain "..".', 'rootPath');
  return '/' + parts.join('/');
}

export interface ParseOptions {
  /** Cloud: refuses `local` and requires a host. */
  cloud: boolean;
  /** Self-hosted roots allowed for `local` (FILE_SOURCE_ROOTS). */
  localRoots?: string[];
  connectorName?: string;
}

export function parseFileSearchConfig(raw: unknown, opts: ParseOptions): FileSearchConfig {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FileSearchConfigError(`Invalid setting "${issue.path.join('.')}": ${issue.message}`, issue.path.join('.'));
  }
  const c = parsed.data;
  const protocol: FileSearchProtocol = c.protocol;

  if (opts.cloud && !CLOUD_PROTOCOLS.has(protocol)) {
    throw new FileSearchConfigError(
      'A network folder can only be connected to a self-hosted AnythingMCP. On AnythingMCP Cloud, connect the folder through SFTP, FTPS or WebDAV.',
      'protocol',
    );
  }

  const out: FileSearchConfig = {
    protocol,
    rootPath: '/',
    include: c.include.length ? c.include : ['**/*'],
    exclude: c.exclude,
    maxDepth: c.maxDepth,
    maxConnections: c.maxConnections,
    toolPrefix: c.toolPrefix && PREFIX_RE.test(c.toolPrefix) ? c.toolPrefix : toolPrefixFrom(opts.connectorName ?? 'files'),
  };
  if (c.maxAgeYears) out.maxAgeYears = c.maxAgeYears;
  if (c.extensions?.length) {
    out.extensions = [...new Set(c.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))];
  }
  if (c.ocr) out.ocr = true;

  if (protocol === 'local') {
    const roots = (opts.localRoots ?? []).map((r) => r.replace(/\/+$/, '') || '/');
    if (!roots.length) {
      throw new FileSearchConfigError(
        'No folder is allowed yet. An administrator sets FILE_SOURCE_ROOTS to the mounted folders AnythingMCP may read.',
        'rootPath',
      );
    }
    const abs = normalizeRelPath(c.rootPath || '/');
    if (!roots.some((r) => abs === r || abs.startsWith(r + '/'))) {
      throw new FileSearchConfigError(`The folder must be inside one of the allowed folders: ${roots.join(', ')}.`, 'rootPath');
    }
    out.rootPath = abs;
    return out;
  }

  if (protocol === 'webdav' || protocol === 's3') {
    const url = (c.url ?? '').trim();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new FileSearchConfigError(
        protocol === 'webdav'
          ? 'Enter the WebDAV address, e.g. https://cloud.example.com/remote.php/dav/files/USER/.'
          : 'Enter the S3 endpoint, e.g. https://fra1.digitaloceanspaces.com.',
        'url',
      );
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !opts.cloud)) {
      throw new FileSearchConfigError('The address must start with https://.', 'url');
    }
    if (u.username || u.password) {
      throw new FileSearchConfigError('Put the user name and password in their own fields, not in the address.', 'url');
    }
    out.url = u.toString();
    out.host = u.hostname;
    out.port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
    if (protocol === 's3') {
      if (!c.bucket) throw new FileSearchConfigError('Enter the bucket name.', 'bucket');
      out.bucket = c.bucket;
      out.region = c.region || 'us-east-1';
    }
    if (c.username) out.username = c.username;
    out.rootPath = normalizeRelPath(c.rootPath || '/');
    return out;
  }

  // sftp / ftp / ftps / ftps-implicit
  const host = (c.host ?? '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  if (!host || !HOST_RE.test(host)) throw new FileSearchConfigError('Enter the server name or IP address.', 'host');
  out.host = host.toLowerCase();
  out.port = c.port ?? DEFAULT_PORTS[protocol] ?? undefined;
  if (!c.username) throw new FileSearchConfigError('Enter the user name.', 'username');
  out.username = c.username;
  out.rootPath = normalizeRelPath(c.rootPath || '/');
  if (c.hostKeySha256) out.hostKeySha256 = c.hostKeySha256;
  if (c.tlsFingerprintSha256) out.tlsFingerprintSha256 = c.tlsFingerprintSha256.toLowerCase().replace(/:/g, '');
  if (protocol === 'ftp') {
    if (!c.allowPlainFtp) {
      throw new FileSearchConfigError(
        'Plain FTP sends the password unencrypted. Confirm that you accept this, or use FTPS or SFTP.',
        'allowPlainFtp',
      );
    }
    out.allowPlainFtp = true;
  }
  return out;
}

/** The secrets the wizard accepts, stored in the encrypted authConfig. */
export interface FileSearchSecrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** S3 */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function pickSecrets(raw: unknown): FileSearchSecrets {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: FileSearchSecrets = {};
  for (const k of ['password', 'privateKey', 'passphrase', 'accessKeyId', 'secretAccessKey'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 16384) out[k] = v;
  }
  return out;
}

/** A display address for the connector list ("sftp://files.example.com:22/Pricelists"). */
export function displayAddress(c: FileSearchConfig): string {
  if (c.protocol === 'local') return `folder:${c.rootPath}`;
  if (c.protocol === 'webdav' || c.protocol === 's3') {
    return `${c.url}${c.protocol === 's3' ? `#${c.bucket}` : ''}`;
  }
  return `${c.protocol}://${c.host}:${c.port}${c.rootPath === '/' ? '' : c.rootPath}`;
}

/** FILE_SOURCE_ROOTS, parsed. */
export function localRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.FILE_SOURCE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('/'))
    .map((s) => s.replace(/\/+$/, '') || '/');
}

/**
 * Strips leading and trailing slashes in linear time. A `/^\/+|\/+$/` regex
 * is quadratic on a long run of slashes, and these strings come from users
 * and from file servers.
 */
export function trimSlashes(s: string, side: 'both' | 'end' = 'both'): string {
  let a = 0;
  let b = s.length;
  if (side === 'both') while (a < b && s.charCodeAt(a) === 47) a++;
  while (b > a && s.charCodeAt(b - 1) === 47) b--;
  return s.slice(a, b);
}

/** AWS and DigitalOcean Spaces use bucket subdomains; other S3 servers path-style buckets. */
export function usesVirtualHostedBuckets(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    const h = new URL(endpoint).hostname.toLowerCase();
    return h.endsWith('.amazonaws.com') || h.endsWith('.digitaloceanspaces.com');
  } catch {
    return false;
  }
}
