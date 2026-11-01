// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { createReadStream } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { FileSearchConfig } from '../../../file-search/file-search.types';
import { localRootsFromEnv } from '../../../file-search/file-search-config';
import {
  classifyNetworkError,
  limitStream,
  safeRel,
  SourceError,
  type ConnectOptions,
  type ConnectResult,
  type FileSourceDriver,
  type RemoteEntry,
} from './source.types';

/**
 * A folder mounted into a self-hosted install (#1382): SMB/CIFS, NFS or a
 * NAS volume mounted on the host and bound read-only into the container.
 * Only below FILE_SOURCE_ROOTS; every path is resolved with realpath and must
 * stay inside the connector's root, so a symlink cannot lead out of it.
 * Refused on the Cloud.
 */
export class LocalDriver implements FileSourceDriver {
  async connect(config: FileSearchConfig, _secrets: unknown, opts: ConnectOptions): Promise<ConnectResult> {
    if (opts.cloud) throw new SourceError('protocol_not_allowed', 'Network folders are not available on AnythingMCP Cloud.');
    const roots = localRootsFromEnv();
    let root: string;
    try {
      root = await realpath(config.rootPath);
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const allowed = await Promise.all(roots.map((r) => realpath(r).catch(() => null)));
    if (!allowed.some((r) => r && (root === r || root.startsWith(r + sep)))) {
      throw new SourceError('root_not_allowed', `The folder is outside FILE_SOURCE_ROOTS (${roots.join(', ') || 'not set'}).`);
    }

    const inside = async (rel: string): Promise<string> => {
      const p = join(root, safeRel(rel));
      const real = await realpath(p).catch((err) => {
        throw classifyNetworkError(err);
      });
      if (real !== root && !real.startsWith(root + sep)) throw new SourceError('permission', 'The path leads outside the folder.');
      return real;
    };

    const session = {
      list: async (relDir: string): Promise<RemoteEntry[]> => {
        const rel = safeRel(relDir);
        const dir = await inside(rel);
        const out: RemoteEntry[] = [];
        try {
          const handle = await opendir(dir);
          for await (const d of handle) {
            if (!d.isFile() && !d.isDirectory()) continue; // symlinks, sockets, devices
            const st = await lstat(join(dir, d.name)).catch(() => null);
            if (!st) continue;
            out.push({
              path: rel ? `${rel}/${d.name}` : d.name,
              name: d.name,
              isDir: d.isDirectory(),
              size: d.isFile() ? st.size : 0,
              mtime: st.mtime,
            });
          }
        } catch (err) {
          throw classifyNetworkError(err);
        }
        return out;
      },
      open: async (relPath: string, maxBytes: number): Promise<Readable> => {
        const p = await inside(relPath);
        const st = await lstat(p);
        if (!st.isFile()) throw new SourceError('permission', 'Not a regular file.');
        if (st.size > maxBytes) throw new SourceError('permission', `The file is larger than the allowed ${maxBytes} bytes.`);
        return limitStream(createReadStream(p, { highWaterMark: 256 * 1024 }), maxBytes);
      },
      close: async () => undefined,
    };
    return { session };
  }
}
