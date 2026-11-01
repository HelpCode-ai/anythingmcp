// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { PassThrough, type Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { Client, enterPassiveModeIPv6, FileType, type FTPContext } from 'basic-ftp';
import { connectForPassiveTransfer, parsePasvResponse } from 'basic-ftp/dist/transfer';
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

/**
 * PASV that always connects to the control connection's address and only
 * takes the port from the reply. A server behind NAT that announces its
 * private address still works, and no reply can point the data channel at
 * another host.
 */
async function pasvToControlHost(ftp: FTPContext) {
  const res = await ftp.request('PASV');
  const target = parsePasvResponse(res.message);
  const host = ftp.socket.remoteAddress?.replace(/^::ffff:/i, '');
  if (!host) throw new Error('The control connection is closed.');
  await connectForPassiveTransfer(host, target.port, ftp);
  return res;
}

/** EPSV (port only) first, then PASV to the control host; the first that works is kept. */
function controlHostTransfers(client: Client) {
  const strategies = [enterPassiveModeIPv6, pasvToControlHost];
  client.prepareTransfer = async (ftp: FTPContext) => {
    let last: unknown;
    for (const s of strategies) {
      try {
        const res = await s(ftp);
        client.prepareTransfer = s;
        return res;
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}

function normFp(fp: string): string {
  return fp.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * FTP, explicit FTPS (AUTH TLS) and implicit FTPS (#1382).
 *
 * - The control connection goes to the address the SSRF guard checked, and
 *   passive data connections only to that same address (the host in a PASV
 *   reply is ignored, only its port is used): a server cannot point the data
 *   channel at an internal host, and NAT setups that announce a private
 *   address still work.
 * - TLS: a certificate a public CA vouches for is accepted; any other
 *   certificate only with its SHA-256 fingerprint pinned (self-signed NAS and
 *   routers). The check runs after the handshake and before the password is
 *   sent.
 */
export class FtpDriver implements FileSourceDriver {
  async connect(config: FileSearchConfig, secrets: FileSearchSecrets, opts: ConnectOptions): Promise<ConnectResult> {
    const host = config.host!;
    let address = host;
    try {
      const pinned = await resolveSafeOutboundHost(host);
      if (pinned?.length) address = pinned[0].address;
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const client = new Client(opts.timeoutMs ?? 30_000, { allowSeparateTransferHost: false });
    controlHostTransfers(client);
    const tlsOptions = { servername: /^[\d.:]+$/.test(host) ? undefined : host, rejectUnauthorized: false };
    let fingerprint: ConnectResult['fingerprint'];
    try {
      if (config.protocol === 'ftps-implicit') {
        await client.connectImplicitTLS(address, config.port ?? 990, tlsOptions);
      } else {
        await client.connect(address, config.port ?? 21);
        if (config.protocol === 'ftps') await client.useTLS(tlsOptions);
      }
      if (config.protocol !== 'ftp') {
        const sock = client.ftp.socket as TLSSocket;
        const cert = sock.getPeerCertificate?.();
        const fp = cert?.fingerprint256 ? normFp(cert.fingerprint256) : '';
        fingerprint = fp ? { kind: 'tls-certificate', sha256: fp } : undefined;
        if (config.tlsFingerprintSha256) {
          if (normFp(config.tlsFingerprintSha256) !== fp) {
            throw new SourceError(
              'fingerprint_mismatch',
              'The server presented a different certificate than the one you confirmed. Ask your administrator before confirming the new one.',
              fingerprint,
            );
          }
        } else if (!sock.authorized) {
          if (!opts.test) {
            throw new SourceError('tls', 'The server certificate is not signed by a trusted authority and its fingerprint is not confirmed.', fingerprint);
          }
          // Test: report it; the password is not sent to an unconfirmed server.
          client.close();
          throw new SourceError(
            'fingerprint_unconfirmed',
            'The server uses a certificate no public authority vouches for (normal for a NAS or router). Check its fingerprint with your administrator and confirm it to continue.',
            fingerprint,
          );
        }
      }
      await client.login(config.username, secrets.password ?? '');
      await client.useDefaultSettings();
    } catch (err) {
      client.close();
      throw classifyNetworkError(err);
    }

    const root = config.rootPath || '/';
    let busy: Promise<unknown> = Promise.resolve();
    // basic-ftp runs one command at a time: serialise list and download.
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = busy.then(fn, fn);
      busy = next.catch(() => undefined);
      return next;
    };

    const session = {
      list: (relDir: string) =>
        serial(async () => {
          const rel = safeRel(relDir);
          let items;
          try {
            items = await client.list(remotePath(root, rel));
          } catch (err) {
            throw classifyNetworkError(err);
          }
          const out: RemoteEntry[] = [];
          for (const it of items) {
            if (it.name === '.' || it.name === '..') continue;
            if (it.type !== FileType.File && it.type !== FileType.Directory) continue;
            out.push({
              path: rel ? `${rel}/${it.name}` : it.name,
              name: it.name,
              isDir: it.type === FileType.Directory,
              size: it.size ?? 0,
              mtime: it.modifiedAt ?? (it.rawModifiedAt ? parseListDate(it.rawModifiedAt) : null),
            });
          }
          return out;
        }),
      open: (relPath: string, maxBytes: number): Promise<Readable> => {
        const p = remotePath(root, safeRel(relPath));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const prev = busy;
        busy = prev.then(() => gate).catch(() => undefined);
        return prev.then(() => {
          const pass = new PassThrough();
          const out = limitStream(pass, maxBytes);
          // The lock is held until the transfer ends, so the next command waits for it.
          client
            .downloadTo(pass, p)
            .catch((err) => out.destroy(classifyNetworkError(err)))
            .finally(release);
          return out;
        });
      },
      close: async () => {
        client.close();
      },
    };
    return { session, fingerprint };
  }
}

/** Best-effort parse of a LIST date ("Oct 09 2024", "Oct 09 14:30", "10-09-24 02:30PM"). */
export function parseListDate(raw: string): Date | null {
  const s = raw.trim();
  const now = new Date();
  let m = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (m) {
    const d = new Date(`${m[1]} ${m[2]} ${m[3]} 00:00:00 UTC`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    let d = new Date(`${m[1]} ${m[2]} ${now.getUTCFullYear()} ${m[3]}:${m[4]}:00 UTC`);
    if (d.getTime() > now.getTime() + 86400_000) d = new Date(`${m[1]} ${m[2]} ${now.getUTCFullYear() - 1} ${m[3]}:${m[4]}:00 UTC`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === 'PM') hour += 12;
    return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]), hour, Number(m[5])));
  }
  return null;
}
