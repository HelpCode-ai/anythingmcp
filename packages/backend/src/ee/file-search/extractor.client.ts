// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Logger } from '@nestjs/common';

/**
 * Client of deploy/ee/file-extractor (#1381). The worker downloads a file and
 * posts the bytes here; the extractor runs on the internal network with no
 * egress, no database and no secrets.
 *
 *   FILE_EXTRACTOR_URL    http://file-extractor:8890
 *   FILE_EXTRACTOR_TOKEN  shared secret (X-Extractor-Token)
 */

export interface ExtractedPage {
  page: number | null;
  text: string;
}

export interface ExtractResult {
  ok: boolean;
  pages: ExtractedPage[];
  meta: { title?: string | null; author?: string | null; pageCount?: number | null; sheetCount?: number | null; format?: string };
  truncated: boolean;
  ocrPages: number;
  emptyPages: number;
  error: { kind: 'unsupported' | 'encrypted' | 'corrupt' | 'timeout' | 'too_large' | 'empty'; message: string } | null;
}

export class ExtractorUnavailableError extends Error {}

export class ExtractorClient {
  private readonly logger = new Logger(ExtractorClient.name);

  get configured(): boolean {
    return !!process.env.FILE_EXTRACTOR_URL && !!process.env.FILE_EXTRACTOR_TOKEN;
  }

  private base(): string {
    const u = (process.env.FILE_EXTRACTOR_URL ?? '').replace(/\/+$/, '');
    if (!u || !process.env.FILE_EXTRACTOR_TOKEN) throw new ExtractorUnavailableError('FILE_EXTRACTOR_URL / FILE_EXTRACTOR_TOKEN are not set.');
    return u;
  }

  async health(): Promise<{ ok: boolean; ocr: boolean }> {
    if (!this.configured) return { ok: false, ocr: false };
    try {
      const r = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!r.ok) return { ok: false, ocr: false };
      const j = (await r.json()) as { ok?: boolean; ocr?: boolean };
      return { ok: !!j.ok, ocr: !!j.ocr };
    } catch {
      return { ok: false, ocr: false };
    }
  }

  async extract(bytes: Buffer, filename: string, opts: { ocr?: boolean; maxChars?: number } = {}): Promise<ExtractResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), 'upload.bin');
    form.append('filename', filename);
    form.append('options', JSON.stringify({ ocr: !!opts.ocr, maxChars: opts.maxChars ?? 2_000_000 }));
    const timeoutMs = bytes.length > 50 * 1024 * 1024 ? 330_000 : 90_000;
    let res: Response;
    try {
      res = await fetch(`${this.base()}/extract`, {
        method: 'POST',
        headers: { 'X-Extractor-Token': process.env.FILE_EXTRACTOR_TOKEN ?? '' },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof ExtractorUnavailableError) throw err;
      throw new ExtractorUnavailableError(`The extractor is not reachable: ${(err as Error).message}`);
    }
    if (res.status === 503 || res.status === 429) throw new ExtractorUnavailableError(`The extractor is busy (${res.status}).`);
    if (res.status === 401) throw new ExtractorUnavailableError('The extractor refused the token (FILE_EXTRACTOR_TOKEN).');
    if (!res.ok) {
      this.logger.warn(`extractor answered ${res.status}`);
      return { ok: false, pages: [], meta: {}, truncated: false, ocrPages: 0, emptyPages: 0, error: { kind: 'corrupt', message: `Extractor error ${res.status}` } };
    }
    return (await res.json()) as ExtractResult;
  }
}
