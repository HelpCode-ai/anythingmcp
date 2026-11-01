// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import type { Readable } from 'node:stream';
import { XMLParser } from 'fast-xml-parser';
import { outboundRequest } from '../../../common/outbound-http';
import type { FileSearchConfig } from '../../../file-search/file-search.types';
import type { FileSearchSecrets } from '../../../file-search/file-search-config';
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

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>`;

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, isArray: (name) => name === 'response' || name === 'propstat' });

function encodePath(p: string): string {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/**
 * WebDAV (#1382): Nextcloud, ownCloud, Synology/QNAP WebDAV, any RFC 4918
 * server. Requests go through the SSRF-guarded HTTP client, so redirects and
 * the resolved address are checked like every connector call.
 */
export class WebdavDriver implements FileSourceDriver {
  async connect(config: FileSearchConfig, secrets: FileSearchSecrets, opts: ConnectOptions): Promise<ConnectResult> {
    const base = new URL(config.url!);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const rootRel = safeRel(config.rootPath || '');
    const auth =
      config.username || secrets.password
        ? 'Basic ' + Buffer.from(`${config.username ?? ''}:${secrets.password ?? ''}`).toString('base64')
        : undefined;
    const headers = (extra: Record<string, string> = {}) => ({ ...(auth ? { Authorization: auth } : {}), ...extra });
    const urlOf = (rel: string, dir: boolean) => {
      const full = [rootRel, rel].filter(Boolean).join('/');
      return new URL(encodePath(full) + (dir && full ? '/' : ''), base).toString();
    };
    const timeout = opts.timeoutMs ?? 30_000;

    const propfind = async (rel: string): Promise<RemoteEntry[]> => {
      let res;
      try {
        res = await outboundRequest<string>(
          {
            method: 'PROPFIND' as any,
            url: urlOf(rel, true),
            headers: headers({ Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }),
            data: PROPFIND_BODY,
            responseType: 'text',
            timeout,
            maxContentLength: 50 * 1024 * 1024,
            validateStatus: () => true,
          },
          { credentialHeaders: ['Authorization'] },
        );
      } catch (err) {
        throw classifyNetworkError(err);
      }
      if (res.status === 401) throw new SourceError('auth', 'Login refused. Check the user name and the app password.');
      if (res.status === 403) throw new SourceError('permission', 'The account may not read this folder.');
      if (res.status === 404) throw new SourceError('not_found', 'The folder does not exist. Check the WebDAV address and the folder.');
      if (res.status !== 207) throw new SourceError('unknown', `The server answered ${res.status} instead of a WebDAV listing. Is this the WebDAV address?`);
      const doc = parser.parse(String(res.data));
      const responses: any[] = doc?.multistatus?.response ?? [];
      const selfPath = decodeURIComponent(new URL(urlOf(rel, true)).pathname).replace(/\/+$/, '');
      const out: RemoteEntry[] = [];
      for (const r of responses) {
        const href = decodeURIComponent(new URL(String(r.href), base).pathname).replace(/\/+$/, '');
        if (href === selfPath) continue;
        const ok = (r.propstat as any[]).find((ps) => /\s200\s/.test(String(ps.status))) ?? r.propstat[0];
        const prop = ok?.prop ?? {};
        const isDir = prop.resourcetype && typeof prop.resourcetype === 'object' && 'collection' in prop.resourcetype;
        const name = href.split('/').pop() ?? '';
        if (!name) continue;
        const mtime = prop.getlastmodified ? new Date(String(prop.getlastmodified)) : null;
        out.push({
          path: rel ? `${rel}/${name}` : name,
          name,
          isDir: !!isDir,
          size: Number(prop.getcontentlength ?? 0) || 0,
          mtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime : null,
          etag: prop.getetag ? String(prop.getetag).replace(/"/g, '') : undefined,
        });
      }
      return out;
    };

    // Connect = list the root, so a wrong address or password fails here.
    await propfind('');

    const session = {
      list: (relDir: string) => propfind(safeRel(relDir)),
      open: async (relPath: string, maxBytes: number): Promise<Readable> => {
        let res;
        try {
          res = await outboundRequest<Readable>(
            { method: 'GET', url: urlOf(safeRel(relPath), false), headers: headers(), responseType: 'stream', timeout: 120_000, validateStatus: () => true },
            { credentialHeaders: ['Authorization'] },
          );
        } catch (err) {
          throw classifyNetworkError(err);
        }
        if (res.status !== 200) {
          (res.data as Readable).destroy?.();
          throw new SourceError(res.status === 404 ? 'not_found' : 'unknown', `The server answered ${res.status} for the file.`);
        }
        const len = Number(res.headers['content-length'] ?? 0);
        if (len && len > maxBytes) {
          (res.data as Readable).destroy();
          throw new SourceError('permission', `The file is larger than the allowed ${maxBytes} bytes.`);
        }
        return limitStream(res.data, maxBytes);
      },
      close: async () => undefined,
    };
    return { session };
  }
}
