import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { FileSearchConfig, FileSourceTestResult } from './file-search.types';
import type { FileSearchSecrets } from './file-search-config';

/**
 * The backend's only way to reach a customer's file server: an internal HTTP
 * call to `files-worker` (#1383). The process that answers MCP calls never
 * opens an FTP/SFTP/WebDAV connection itself, so a slow or hostile server
 * cannot tie up its event loop, and source credentials are only decrypted
 * where they are used.
 *
 *   FILES_WORKER_URL    http://files-worker:8891 (internal network only)
 *   FILES_WORKER_TOKEN  shared secret, sent as X-Worker-Token
 */

export class FilesWorkerUnavailableError extends ServiceUnavailableException {
  constructor(message = 'File Search is not running: the files worker is not configured or not reachable.') {
    super({ statusCode: 503, code: 'files_worker_unavailable', message });
  }
}

export interface FetchedFile {
  bytes: Buffer;
  contentType: string;
  filename: string;
  size: number;
}

@Injectable()
export class FilesWorkerClient {
  private readonly logger = new Logger(FilesWorkerClient.name);

  get configured(): boolean {
    return !!process.env.FILES_WORKER_URL && !!process.env.FILES_WORKER_TOKEN;
  }

  private url(path: string): string {
    const base = (process.env.FILES_WORKER_URL ?? '').replace(/\/+$/, '');
    if (!base || !process.env.FILES_WORKER_TOKEN) throw new FilesWorkerUnavailableError();
    return `${base}${path}`;
  }

  private headers(json = true): Record<string, string> {
    return {
      'X-Worker-Token': process.env.FILES_WORKER_TOKEN ?? '',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  /** Health of the worker and its extractor, for the wizard and the admin page. */
  async health(): Promise<{ ok: boolean; extractor: boolean; ocr: boolean; version?: string; error?: string }> {
    if (!this.configured) return { ok: false, extractor: false, ocr: false, error: 'not_configured' };
    try {
      const res = await fetch(this.url('/internal/health'), { headers: this.headers(false), signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return { ok: false, extractor: false, ocr: false, error: `status_${res.status}` };
      return (await res.json()) as { ok: boolean; extractor: boolean; ocr: boolean; version?: string };
    } catch (err) {
      return { ok: false, extractor: false, ocr: false, error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  /** Wizard step 2: connect with unsaved settings, list the root, disconnect. */
  async test(config: FileSearchConfig, secrets: FileSearchSecrets, opts: { cloud: boolean }): Promise<FileSourceTestResult> {
    const res = await this.post('/internal/test', { config, secrets, cloud: opts.cloud }, 45_000);
    return (await res.json()) as FileSourceTestResult;
  }

  /** The file itself, read live by the worker (get_file / share_file). */
  async fetchFile(organizationId: string, connectorId: string, path: string, maxBytes: number): Promise<FetchedFile> {
    const res = await this.post('/internal/fetch', { organizationId, connectorId, path, maxBytes }, 60_000);
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    if (type.startsWith('application/json')) {
      const body = (await res.json()) as { error?: string; message?: string };
      throw new Error(body.message ?? body.error ?? 'The file could not be read.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('The file is larger than allowed.');
    return {
      bytes: buf,
      contentType: type,
      filename: decodeURIComponent(res.headers.get('x-filename') ?? 'file'),
      size: buf.length,
    };
  }

  /** Nudges the scheduler (Sync now, Resume, Activate) so it does not wait for its next tick. */
  async kick(connectorId: string): Promise<void> {
    if (!this.configured) return;
    try {
      await this.post('/internal/kick', { connectorId }, 3_000);
    } catch (err) {
      this.logger.debug(`kick failed: ${(err as Error).message}`);
    }
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof FilesWorkerUnavailableError) throw err;
      this.logger.warn(`files-worker ${path} failed: ${(err as Error).message}`);
      throw new FilesWorkerUnavailableError(
        (err as Error).name === 'TimeoutError'
          ? 'The files worker did not answer in time.'
          : 'The files worker is not reachable.',
      );
    }
    if (res.status === 401 || res.status === 403) throw new FilesWorkerUnavailableError('The files worker refused the token (FILES_WORKER_TOKEN).');
    if (res.status >= 500 && !(res.headers.get('content-type') ?? '').startsWith('application/json')) {
      throw new FilesWorkerUnavailableError(`The files worker failed (${res.status}).`);
    }
    return res;
  }
}
