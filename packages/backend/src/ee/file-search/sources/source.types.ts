// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Transform, type Readable } from 'node:stream';
import type { FileSearchConfig, FileSourceTestResult } from '../../../file-search/file-search.types';
import type { FileSearchSecrets } from '../../../file-search/file-search-config';

/** One entry of a folder listing, path relative to the connector's root ('/'-separated, no leading slash). */
export interface RemoteEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: Date | null;
  etag?: string;
}

/** An open connection to a source. Every driver closes it in `close`, also after errors. */
export interface SourceSession {
  /** Entries of one folder (relative path, '' = root). Symlinks are skipped. */
  list(relDir: string): Promise<RemoteEntry[]>;
  /** A stream of the file; it errors when more than `maxBytes` arrive. */
  open(relPath: string, maxBytes: number): Promise<Readable>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  cloud: boolean;
  /** Test mode: an unpinned fingerprint is reported for confirmation instead of failing. */
  test?: boolean;
  timeoutMs?: number;
}

export interface ConnectResult {
  session: SourceSession;
  fingerprint?: FileSourceTestResult['fingerprint'];
  /** Set in test mode when the fingerprint is not pinned yet (or TLS is not CA-valid). */
  needsConfirmation?: boolean;
}

export interface FileSourceDriver {
  connect(config: FileSearchConfig, secrets: FileSearchSecrets, opts: ConnectOptions): Promise<ConnectResult>;
}

export type SourceErrorKind = NonNullable<FileSourceTestResult['errorKind']>;

export class SourceError extends Error {
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly fingerprint?: FileSourceTestResult['fingerprint'],
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/** Joins the connector root and a relative path into a remote absolute path. */
export function remotePath(root: string, rel: string): string {
  const r = (root || '/').replace(/\/+$/, '');
  const p = rel.replace(/^\/+/, '');
  return p ? `${r}/${p}` : r || '/';
}

/** Relative path, rejecting anything that could leave the root. */
export function safeRel(rel: string): string {
  if (rel.includes('\0')) throw new SourceError('permission', 'Invalid path.');
  const parts = rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new SourceError('permission', 'Invalid path.');
  return parts.join('/');
}

/** Maps low-level network errors to the wizard's error kinds. */
export function classifyNetworkError(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  const e = err as NodeJS.ErrnoException & { level?: string };
  const msg = e?.message ?? String(err);
  if (e?.name === 'SsrfBlockedError' || /SSRF guard/.test(msg)) {
    return new SourceError('private_address', 'This address is in a private network or not public. AnythingMCP Cloud cannot reach it; a self-hosted AnythingMCP can, once an administrator allows the host.');
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new SourceError('dns', 'The server name could not be found. Check the spelling.');
  if (e?.code === 'ECONNREFUSED') return new SourceError('unreachable', 'The server refused the connection on this port. Is the service enabled and the port right?');
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' || /timed? ?out/i.test(msg)) return new SourceError('timeout', 'The server did not answer in time. Is the port open to the internet (firewall, router)?');
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return new SourceError('unreachable', 'The server is not reachable from here.');
  if (e?.level === 'client-authentication' || /authentication|login incorrect|530|not logged in|permission denied \(password|auth/i.test(msg)) {
    return new SourceError('auth', 'Login refused. Check the user name and the password or key.');
  }
  if (/ENOENT|no such file|550|not found|404/i.test(msg)) return new SourceError('not_found', 'The folder does not exist on the server. Check the path.');
  if (/EACCES|permission denied|403/i.test(msg)) return new SourceError('permission', 'The account may not read this folder.');
  if (/certificate|self.signed|tls|ssl/i.test(msg)) return new SourceError('tls', `The secure connection failed: ${msg}`);
  return new SourceError('unknown', msg.slice(0, 300));
}

/** Pipes a stream through a byte counter that fails once more than `max` bytes have passed. */
export function limitStream(src: Readable, max: number): Readable {
  let seen = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(new SourceError('permission', `The file is larger than the allowed ${max} bytes.`));
      else cb(null, chunk);
    },
  });
  src.on('error', (err) => t.destroy(err));
  t.on('close', () => {
    if (!src.destroyed) src.destroy();
  });
  return src.pipe(t);
}
