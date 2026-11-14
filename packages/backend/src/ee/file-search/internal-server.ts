// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FileSearchRepository } from '../../file-search/file-search.repository';
import { parseFileSearchConfig, localRootsFromEnv, pickSecrets } from '../../file-search/file-search-config';
import type { FileSourceTestResult, FileSourceTestStep } from '../../file-search/file-search.types';
import { mimeFor } from '../../file-search/file-share.service';
import { ExtractorClient, ExtractorUnavailableError, type RenderResult } from './extractor.client';
import { driverFor } from './sources';
import { SourceError } from './sources/source.types';
import { isCloud, openSource } from './source-context';
import { readAll } from './sync/walk';
import type { Scheduler } from './sync/scheduler';

/**
 * The worker's internal HTTP endpoints (#1383), for the backend only:
 * internal network, shared token (FILES_WORKER_TOKEN), no public port.
 *
 *   GET  /internal/health   worker + extractor
 *   POST /internal/test     connect with unsaved settings, list the root
 *   POST /internal/fetch    one indexed file, read live from the source
 *   POST /internal/render   one page of an indexed PDF or image as a JPEG
 *   POST /internal/kick     run the scheduler now
 */

const STEP_ORDER: FileSourceTestStep['key'][] = ['resolve', 'connect', 'handshake', 'fingerprint', 'login', 'folder'];
const FAIL_AT: Record<string, FileSourceTestStep['key']> = {
  dns: 'resolve',
  private_address: 'resolve',
  unreachable: 'connect',
  timeout: 'connect',
  tls: 'handshake',
  fingerprint_mismatch: 'fingerprint',
  fingerprint_unconfirmed: 'fingerprint',
  auth: 'login',
  not_found: 'folder',
  permission: 'folder',
  root_not_allowed: 'folder',
  protocol_not_allowed: 'resolve',
  plain_ftp_unacknowledged: 'resolve',
  unknown: 'connect',
};

function stepsFor(protocol: string, failedAt?: FileSourceTestStep['key'], detail?: string): FileSourceTestStep[] {
  const keys = STEP_ORDER.filter((k) => {
    if (protocol === 'local') return k === 'folder';
    if (k === 'fingerprint') return protocol === 'sftp' || protocol === 'ftps' || protocol === 'ftps-implicit';
    if (k === 'handshake') return protocol !== 'ftp';
    return true;
  });
  const out: FileSourceTestStep[] = [];
  for (const k of keys) {
    if (failedAt && k === failedAt) {
      out.push({ key: k, ok: false, detail });
      break;
    }
    out.push({ key: k, ok: true });
  }
  return out;
}

export class InternalServer {
  private readonly logger = new Logger(InternalServer.name);
  private server: Server | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly extractor: ExtractorClient,
    private readonly scheduler: Scheduler,
  ) {}

  listen(port: number, host: string): void {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(port, host, () => this.logger.log(`files-worker internal API on ${host}:${port}`));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    const expected = process.env.FILES_WORKER_TOKEN ?? '';
    const given = String(req.headers['x-worker-token'] ?? '');
    if (!expected || expected.length < 16 || given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 1024 * 1024) throw new Error('Body too large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(req)) return this.json(res, 401, { error: 'unauthorized' });
      const url = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && url === '/internal/health') {
        const ex = await this.extractor.health();
        return this.json(res, 200, { ok: true, extractor: ex.ok, ocr: ex.ocr, version: '1', busy: this.scheduler.busy });
      }
      if (req.method === 'POST' && url === '/internal/kick') {
        this.scheduler.kick();
        return this.json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/internal/test') return this.json(res, 200, await this.test(await this.body(req)));
      if (req.method === 'POST' && url === '/internal/fetch') return this.fetch(await this.body(req), res);
      if (req.method === 'POST' && url === '/internal/render') return this.json(res, 200, await this.render(await this.body(req)));
      return this.json(res, 404, { error: 'not_found' });
    } catch (err) {
      this.logger.warn(`internal ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) this.json(res, 500, { error: 'internal', message: (err as Error).message });
      else res.destroy();
    }
  }

  private async test(body: { config: unknown; secrets: unknown }): Promise<FileSourceTestResult> {
    let config;
    try {
      config = parseFileSearchConfig(body.config, { cloud: isCloud(), localRoots: localRootsFromEnv() });
    } catch (err) {
      return { ok: false, steps: [], errorKind: 'unknown', message: (err as Error).message };
    }
    const secrets = pickSecrets(body.secrets);
    let session;
    try {
      const r = await driverFor(config.protocol).connect(config, secrets, { cloud: isCloud(), test: true, timeoutMs: 20_000 });
      session = r.session;
      const entries = await session.list('');
      return {
        ok: true,
        steps: stepsFor(config.protocol),
        fingerprint: r.fingerprint,
        rootEntries: entries.length,
        sample: entries
          .slice(0, 12)
          .map((e) => (e.isDir ? `${e.name}/` : e.name)),
        ...(r.needsConfirmation && r.fingerprint
          ? { errorKind: 'fingerprint_unconfirmed' as const, message: 'Check the server fingerprint with your administrator and confirm it.' }
          : {}),
      };
    } catch (err) {
      const e = err instanceof SourceError ? err : new SourceError('unknown', (err as Error).message);
      return { ok: false, steps: stepsFor(config.protocol, FAIL_AT[e.kind] ?? 'connect', e.message), fingerprint: e.fingerprint, errorKind: e.kind, message: e.message };
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  /**
   * Reads one file live, only when it is in the connector's index (the
   * caller's scope was checked by the backend). Errors are returned, not thrown.
   */
  private async readIndexed(body: { organizationId: string; connectorId: string; path: string; maxBytes: number }): Promise<
    { ok: true; name: string; buf: Buffer } | { ok: false; status: number; error: string; message: string }
  > {
    const maxBytes = Math.min(Math.max(Number(body.maxBytes) || 0, 1), 1024 * 1024 * 1024);
    const connector = await this.prisma.connector.findFirst({ where: { id: body.connectorId, organizationId: body.organizationId } });
    if (!connector) return { ok: false, status: 404, error: 'not_found', message: 'Connector not found.' };
    const entry = await this.repo.withTenant(body.organizationId, (tx) =>
      tx.fileEntry.findFirst({ where: { connectorId: body.connectorId, organizationId: body.organizationId, path: String(body.path ?? '') }, select: { path: true, name: true } }),
    );
    if (!entry) return { ok: false, status: 404, error: 'not_found', message: 'The file is not in the index.' };
    const { session } = await openSource(connector);
    try {
      const buf = await readAll(await session.open(entry.path, maxBytes), maxBytes);
      return { ok: true, name: entry.name, buf };
    } catch (err) {
      return { ok: false, status: 200, error: 'read_failed', message: (err as Error).message };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  private async fetch(body: { organizationId: string; connectorId: string; path: string; maxBytes: number }, res: ServerResponse): Promise<void> {
    const r = await this.readIndexed(body);
    if (!r.ok) return this.json(res, r.status, { error: r.error, message: r.message });
    res.writeHead(200, {
      'Content-Type': mimeFor(r.name),
      'Content-Length': String(r.buf.length),
      'X-Filename': encodeURIComponent(r.name),
    });
    res.end(r.buf);
  }

  /** One page of an indexed PDF or image as a JPEG, rendered by the extractor (`_view_page`). */
  private async render(body: { organizationId: string; connectorId: string; path: string; maxBytes: number; page?: number; maxPx?: number }): Promise<RenderResult> {
    const r = await this.readIndexed(body);
    if (!r.ok) return { ok: false, error: { kind: r.error === 'not_found' ? 'not_found' : 'read_failed', message: r.message } };
    try {
      return await this.extractor.render(r.buf, r.name, { page: body.page, maxPx: body.maxPx });
    } catch (err) {
      if (err instanceof ExtractorUnavailableError) return { ok: false, error: { kind: 'unavailable', message: err.message } };
      throw err;
    }
  }
}
