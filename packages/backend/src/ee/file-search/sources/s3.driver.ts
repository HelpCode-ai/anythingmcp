// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import type { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createSsrfGuardedAgents } from '../../../common/ssrf.util';
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

/**
 * S3-compatible buckets (#1388): AWS, DigitalOcean Spaces, MinIO, Hetzner,
 * Wasabi. Folders are key prefixes; the SDK's sockets go through the
 * SSRF-guarded agents.
 */
export class S3Driver implements FileSourceDriver {
  async connect(config: FileSearchConfig, secrets: FileSearchSecrets, opts: ConnectOptions): Promise<ConnectResult> {
    if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new SourceError('auth', 'Enter the access key and the secret key.');
    const { httpAgent, httpsAgent } = createSsrfGuardedAgents();
    const endpoint = config.url!;
    const client = new S3Client({
      endpoint,
      region: config.region || 'us-east-1',
      forcePathStyle: !/amazonaws\.com|digitaloceanspaces\.com/.test(endpoint),
      credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
      requestHandler: new NodeHttpHandler({ httpAgent, httpsAgent, connectionTimeout: opts.timeoutMs ?? 20_000, requestTimeout: 120_000 }),
    });
    const bucket = config.bucket!;
    const rootPrefix = safeRel(config.rootPath || '');
    const prefixOf = (rel: string) => [rootPrefix, safeRel(rel)].filter(Boolean).join('/');

    const list = async (relDir: string): Promise<RemoteEntry[]> => {
      const rel = safeRel(relDir);
      const prefix = prefixOf(rel);
      const out: RemoteEntry[] = [];
      let token: string | undefined;
      try {
        do {
          const res = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix ? `${prefix}/` : undefined, Delimiter: '/', ContinuationToken: token, MaxKeys: 1000 }),
          );
          for (const cp of res.CommonPrefixes ?? []) {
            const name = (cp.Prefix ?? '').slice(prefix ? prefix.length + 1 : 0).replace(/\/$/, '');
            if (name) out.push({ path: rel ? `${rel}/${name}` : name, name, isDir: true, size: 0, mtime: null });
          }
          for (const o of res.Contents ?? []) {
            const name = (o.Key ?? '').slice(prefix ? prefix.length + 1 : 0);
            if (!name || name.endsWith('/')) continue;
            out.push({ path: rel ? `${rel}/${name}` : name, name, isDir: false, size: Number(o.Size ?? 0), mtime: o.LastModified ?? null, etag: o.ETag?.replace(/"/g, '') });
          }
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token && out.length < 100_000);
      } catch (err: any) {
        if (err?.name === 'NoSuchBucket') throw new SourceError('not_found', 'The bucket does not exist.');
        if (err?.name === 'AccessDenied' || err?.$metadata?.httpStatusCode === 403) throw new SourceError('auth', 'Access denied. Check the keys and their permissions on the bucket.');
        throw classifyNetworkError(err);
      }
      return out;
    };

    await list('');
    return {
      session: {
        list,
        open: async (relPath: string, maxBytes: number): Promise<Readable> => {
          try {
            const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefixOf(relPath) }));
            if ((res.ContentLength ?? 0) > maxBytes) {
              (res.Body as Readable).destroy();
              throw new SourceError('permission', `The file is larger than the allowed ${maxBytes} bytes.`);
            }
            return limitStream(res.Body as Readable, maxBytes);
          } catch (err) {
            throw classifyNetworkError(err);
          }
        },
        close: async () => client.destroy(),
      },
    };
  }
}
