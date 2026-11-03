// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client, type SFTPWrapper, type FileEntryWithStats } from 'ssh2';
import { resolveSafeOutboundHost } from '../../../common/ssrf.util';
import type { FileSearchConfig } from '../../../file-search/file-search.types';
import type { FileSearchSecrets } from '../../../file-search/file-search-config';
import {
  classifyNetworkError,
  limitStream,
  remotePath,
  safeRel,
  SourceError,
  type ConnectOptions,
  type ConnectResult,
  type FileSourceDriver,
  type RemoteEntry,
} from './source.types';

/** OpenSSH-style fingerprint of a raw host key: "SHA256:<base64 without padding>". */
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/**
 * SFTP (#1382). The host key is pinned: the first test reports its
 * fingerprint for the admin to confirm, and every later connection refuses a
 * different key before sending the password.
 */
export class SftpDriver implements FileSourceDriver {
  async connect(config: FileSearchConfig, secrets: FileSearchSecrets, opts: ConnectOptions): Promise<ConnectResult> {
    const host = config.host!;
    let address = host;
    try {
      const pinned = await resolveSafeOutboundHost(host);
      if (pinned?.length) address = pinned[0].address;
    } catch (err) {
      throw classifyNetworkError(err);
    }
    let seen: string | undefined;
    let mismatch = false;
    const client = new Client();
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(new SourceError('timeout', 'The server did not answer in time. Is the port open to the internet?'));
      }, opts.timeoutMs ?? 20_000);
      client
        .on('ready', () => {
          client.sftp((err, s) => {
            clearTimeout(timer);
            if (err) {
              client.end();
              reject(new SourceError('permission', `The server accepted the login but not SFTP: ${err.message}`));
            } else resolve(s);
          });
        })
        .on('error', (err) => {
          clearTimeout(timer);
          client.end();
          if (mismatch) {
            reject(
              new SourceError(
                'fingerprint_mismatch',
                'The server presented a different host key than the one you confirmed. Someone may be impersonating it, or the server was reinstalled. Ask your administrator before confirming the new key.',
                { kind: 'ssh-host-key', sha256: seen! },
              ),
            );
          } else reject(classifyNetworkError(err));
        })
        .connect({
          host: address,
          port: config.port ?? 22,
          username: config.username,
          password: secrets.password,
          privateKey: secrets.privateKey,
          passphrase: secrets.passphrase,
          readyTimeout: opts.timeoutMs ?? 20_000,
          keepaliveInterval: 15_000,
          hostVerifier: (key: Buffer) => {
            seen = sshFingerprint(key);
            if (config.hostKeySha256) {
              mismatch = seen !== config.hostKeySha256;
              return !mismatch;
            }
            // Unpinned: only a test may go on (TOFU, like ssh's first connect).
            return !!opts.test;
          },
        });
    });

    const root = config.rootPath || '/';
    const session = {
      list: (relDir: string) =>
        new Promise<RemoteEntry[]>((resolve, reject) => {
          const rel = safeRel(relDir);
          sftp.readdir(remotePath(root, rel), (err, list: FileEntryWithStats[]) => {
            if (err) return reject(classifyNetworkError(err));
            const out: RemoteEntry[] = [];
            for (const e of list) {
              if (e.filename === '.' || e.filename === '..') continue;
              const type = (e.attrs.mode ?? 0) & S_IFMT;
              if (type !== S_IFDIR && type !== S_IFREG) continue; // symlinks, devices
              out.push({
                path: rel ? `${rel}/${e.filename}` : e.filename,
                name: e.filename,
                isDir: type === S_IFDIR,
                size: Number(e.attrs.size ?? 0),
                mtime: e.attrs.mtime ? new Date(e.attrs.mtime * 1000) : null,
              });
            }
            resolve(out);
          });
        }),
      open: async (relPath: string, maxBytes: number): Promise<Readable> => {
        const p = remotePath(root, safeRel(relPath));
        return limitStream(sftp.createReadStream(p, { highWaterMark: 256 * 1024 }) as unknown as Readable, maxBytes);
      },
      close: async () => {
        try {
          sftp.end();
        } catch {
          /* already closed */
        }
        client.end();
      },
    };
    return {
      session,
      fingerprint: seen ? { kind: 'ssh-host-key', sha256: seen } : undefined,
      needsConfirmation: !config.hostKeySha256,
    };
  }
}
