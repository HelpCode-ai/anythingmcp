import { BINARY_MARKER, isBinaryBody, renderBinaryBody, readBinaryConfig } from '../connectors/binary-response.util';
import { FileSearchEngine } from './file-search.engine';

const MB = 1024 * 1024;
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');

function make(opts: { entry?: { path: string; size: number; status: string } | null; render?: unknown; maxFileBytes?: number } = {}) {
  const query = { entry: jest.fn().mockResolvedValue(opts.entry === undefined ? { path: 'Plans/EG.pdf', size: 2 * MB, status: 'indexed' } : opts.entry) };
  const access = { resolve: jest.fn().mockResolvedValue({ allowed: true, quota: { maxFileBytes: opts.maxFileBytes ?? 50 * MB, folderRules: false } }) };
  const worker = {
    render: jest.fn().mockResolvedValue(
      opts.render ?? { ok: true, mimeType: 'image/jpeg', base64: JPEG_BASE64, width: 1131, height: 1600, page: 2, pageCount: 3 },
    ),
  };
  const engine = new FileSearchEngine({} as any, query as any, access as any, worker as any, {} as any);
  return { engine, query, access, worker };
}

const ctx = { organizationId: 'org-1', connectorId: 'conn-1' };

describe('FileSearchEngine file_view', () => {
  it('returns the page as a JPEG binary body that leaves as MCP image content', async () => {
    const { engine, worker, query } = make();
    const out = await engine.execute('file_view', { path: 'Plans/EG.pdf', page: 2 }, ctx);

    expect(query.entry).toHaveBeenCalledWith({ organizationId: 'org-1', connectorId: 'conn-1' }, 'Plans/EG.pdf');
    expect(worker.render).toHaveBeenCalledWith('org-1', 'conn-1', 'Plans/EG.pdf', { page: 2, maxBytes: 50 * MB });
    expect(isBinaryBody(out)).toBe(true);
    const body = out as Record<string, any>;
    expect(body[BINARY_MARKER]).toBe(1);
    expect(body.contentType).toBe('image/jpeg');
    expect(body.filename).toBe('EG-page-2.jpg');
    expect(body.extra).toEqual({ path: 'Plans/EG.pdf', page: 2, pageCount: 3, width: 1131, height: 1600, note: 'Use page 3 for the next page.' });

    const rendered = renderBinaryBody(body as any, readBinaryConfig(undefined));
    expect(rendered.content).toEqual([{ type: 'image', data: JPEG_BASE64, mimeType: 'image/jpeg' }]);
    expect(rendered.value).toMatchObject({ path: 'Plans/EG.pdf', page: 2, pageCount: 3 });
  });

  it('defaults to page 1 and says when it is the last page', async () => {
    const { engine, worker } = make({ render: { ok: true, base64: JPEG_BASE64, width: 10, height: 10, page: 1, pageCount: 1 } });
    const out = (await engine.execute('file_view', { path: 'Plans/EG.pdf' }, ctx)) as Record<string, any>;
    expect(worker.render.mock.calls[0][3].page).toBe(1);
    expect(out.extra.note).toBe('This is the last page.');
  });

  it('refuses a path outside the caller scope or the index without reading anything', async () => {
    const { engine, worker } = make({ entry: null });
    const out = await engine.execute('file_view', { path: 'Geheim/Lohn.pdf' }, ctx);
    expect(out).toEqual({ error: 'No file "Geheim/Lohn.pdf" in this folder. Use find or list to get the exact path.' });
    expect(worker.render).not.toHaveBeenCalled();
  });

  it('refuses file types the renderer does not show and points to read', async () => {
    const { engine, worker } = make({ entry: { path: 'Preise/Liste.xlsx', size: 1000, status: 'indexed' } });
    const out = (await engine.execute('file_view', { path: 'Preise/Liste.xlsx' }, ctx)) as Record<string, any>;
    expect(out.error).toBe('unsupported');
    expect(out.message).toMatch(/read tool/);
    expect(worker.render).not.toHaveBeenCalled();
  });

  it('shows images, case-insensitively by extension', async () => {
    const { engine, worker } = make({ entry: { path: 'Fotos/Tür.JPG', size: 1000, status: 'name_only' } });
    expect(isBinaryBody(await engine.execute('file_view', { path: 'Fotos/Tür.JPG' }, ctx))).toBe(true);
    expect(worker.render).toHaveBeenCalled();
  });

  it('refuses files above the plan limit', async () => {
    const { engine, worker } = make({ entry: { path: 'Plans/Gross.pdf', size: 80 * MB, status: 'skipped_size' }, maxFileBytes: 50 * MB });
    const out = (await engine.execute('file_view', { path: 'Plans/Gross.pdf' }, ctx)) as Record<string, any>;
    expect(out.error).toBe('too_large');
    expect(worker.render).not.toHaveBeenCalled();
  });

  it('rejects a page below 1', async () => {
    const { engine, worker } = make();
    expect(await engine.execute('file_view', { path: 'Plans/EG.pdf', page: 0 }, ctx)).toEqual({ error: 'Pass page as a number from 1.' });
    expect(worker.render).not.toHaveBeenCalled();
  });

  it('passes renderer errors through with a hint for a page out of range', async () => {
    const { engine } = make({ render: { ok: false, error: { kind: 'page_out_of_range', message: 'Page 9 does not exist; the file has 3 pages.' } } });
    const out = (await engine.execute('file_view', { path: 'Plans/EG.pdf', page: 9 }, ctx)) as Record<string, any>;
    expect(out).toMatchObject({ error: 'page_out_of_range', message: 'Page 9 does not exist; the file has 3 pages.', path: 'Plans/EG.pdf' });
    expect(out.hint).toBeTruthy();
  });

  it('is locked like every File Search tool when the plan does not allow File Search', async () => {
    const { engine, access, worker } = make();
    access.resolve.mockResolvedValue({ allowed: false, message: 'File Search needs a paid plan.' });
    const out = (await engine.execute('file_view', { path: 'Plans/EG.pdf' }, ctx)) as Record<string, any>;
    expect(out.error).toBe('file_search_locked');
    expect(worker.render).not.toHaveBeenCalled();
  });
});
