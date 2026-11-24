import { Resvg } from '@resvg/resvg-js';
import { oneNotePageSummary, oneNoteResourcePath, renderOneNotePage } from './onenote-page-renderer';

const NS = 'http://www.w3.org/2003/InkML';
const html = (contents: string) => `<html><body>${contents}</body></html>`;
const resource = 'https://graph.microsoft.com/v1.0/me/onenote/resources/image-id/content';
const redSquare = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>', { font: { loadSystemFonts: false } }).render().asPng();
// A generated 4x4 red square, saved as JPEG; no external page or user data.
const redJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==', 'base64');
const ink = (samples: string) => `<ink xmlns="${NS}"><definitions><context xml:id="xy"><traceFormat><channel name="X" units="px"/><channel name="Y" units="px"/></traceFormat></context><brush xml:id="blue"><brushProperty name="color" value="#0000ff"/><brushProperty name="width" value="4" units="px"/></brush></definitions><trace contextRef="#xy" brushRef="#blue">${samples}</trace></ink>`;
function document(presentation: string, drawing?: string) {
  if (!drawing) return { body: Buffer.from(presentation), contentType: 'text/html' };
  return {
    body: Buffer.from(`--fixture\r\nContent-Type: text/html\r\n\r\n${presentation}\r\n--fixture\r\nContent-Type: application/inkml+xml\r\n\r\n${drawing}\r\n--fixture--\r\n`),
    contentType: 'multipart/mixed; boundary=fixture',
  };
}
const deadline = () => Date.now() + 10_000;

describe('OneNote resource URL boundary', () => {
  it('reconstructs only the same Graph owner and drops the query', () => {
    expect(oneNoteResourcePath(`${resource}?access_token=not-forwarded`, '/me')).toBe('/me/onenote/resources/image-id/content');
    expect(oneNoteResourcePath('https://graph.microsoft.com/v1.0/groups/group-id/onenote/resources/a%2Fb/content', '/groups/group-id')).toBe('/groups/group-id/onenote/resources/a%2Fb/content');
  });

  it('normalizes documented legacy OneNote image URIs without fetching that origin', () => {
    expect(oneNoteResourcePath('https://www.onenote.com/api/v1.0/me/notes/resources/image-id/$value?publicAuth=true', '/me')).toBe('/me/onenote/resources/image-id/content');
    expect(oneNoteResourcePath('https://www.onenote.com/api/v1.0/resources/image-id/$value', '/me')).toBe('/me/onenote/resources/image-id/content');
    expect(oneNoteResourcePath('https://graph.microsoft.com/v1.0/me/onenote/resources/image-id/$value', '/me')).toBe('/me/onenote/resources/image-id/content');
    expect(() => oneNoteResourcePath('https://www.onenote.com/other/image-id', '/me')).toThrow();
  });

  it.each([
    'https://attacker.example/image',
    'http://graph.microsoft.com/v1.0/me/onenote/resources/a/content',
    'https://graph.microsoft.com.attacker.example/v1.0/me/onenote/resources/a/content',
    'https://name:secret@graph.microsoft.com/v1.0/me/onenote/resources/a/content',
    'https://graph.microsoft.com/v1.0/users/other/onenote/resources/a/content',
    'https://graph.microsoft.com/v1.0/me/drive/items/a/content',
    'file:///etc/passwd',
  ])('refuses %s', (url) => expect(() => oneNoteResourcePath(url, '/me')).toThrow());
});

describe('OneNote page rasterization', () => {
  it('renders real PNG tiles and keeps typed text separate', async () => {
    const fetchResource = jest.fn().mockResolvedValue({ body: redSquare, contentType: 'image/png' });
    const result = await renderOneNotePage(document(html(`<p>Meeting notes</p><img src="${resource}" width="10" height="10" style="left:10px;top:20px"/>`), ink('30 20, 50 20')), '/me', fetchResource, deadline());
    expect(result.text).toBe('Meeting notes');
    expect(result.tiles).toHaveLength(1);
    expect(fetchResource).toHaveBeenCalledWith('/me/onenote/resources/image-id/content', expect.any(Number), 4 * 1024 * 1024);
    const png = Buffer.from(result.tiles[0].data, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(result.tiles[0].width);
    expect(png.readUInt32BE(20)).toBe(result.tiles[0].height);
    // Decode the actual returned PNG and check placement and stroke color.
    const tile = result.tiles[0];
    const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${tile.height}"><image width="${tile.width}" height="${tile.height}" href="data:image/png;base64,${tile.data}"/></svg>`, { font: { loadSystemFonts: false } }).render();
    const pixel = (x: number, y: number) => [...raster.pixels.subarray(((y - tile.y) * tile.width + x - tile.x) * 4, ((y - tile.y) * tile.width + x - tile.x) * 4 + 4)];
    expect(pixel(15, 25)).toEqual([255, 0, 0, 255]);
    expect(pixel(40, 20)).toEqual([0, 0, 255, 255]);
    const summary = oneNotePageSummary(result);
    expect(JSON.stringify(summary)).not.toContain(result.tiles[0].data);
    expect(summary.tiles[0]).toMatchObject({ bytes: png.length, width: result.tiles[0].width });
  });

  it('tiles a tall page without shrinking handwriting', async () => {
    const result = await renderOneNotePage(document(html('<p>Tall</p>'), ink('20 20, 20 3200')), '/me', jest.fn(), deadline());
    expect(result.tiles).toHaveLength(3);
    expect(result.tiles.map((tile) => tile.height)).toEqual([1500, 1500, result.height - 3000]);
    expect(result.tiles.every((tile) => tile.width <= 1500 && tile.height <= 1500)).toBe(true);
  });

  it('decodes a JPEG resource into the returned PNG even with a generic content type', async () => {
    const result = await renderOneNotePage(document(html(`<img src="${resource}" width="4" height="4"/>`)), '/me', jest.fn().mockResolvedValue({ body: redJpeg, contentType: 'application/octet-stream' }), deadline());
    const tile = result.tiles[0];
    const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${tile.height}"><image width="${tile.width}" height="${tile.height}" href="data:image/png;base64,${tile.data}"/></svg>`, { font: { loadSystemFonts: false } }).render();
    const offset = ((1 - tile.y) * tile.width + 1 - tile.x) * 4;
    expect(raster.pixels[offset]).toBeGreaterThan(240);
    expect(raster.pixels[offset + 1]).toBeLessThan(20);
    expect(raster.pixels[offset + 2]).toBeLessThan(20);
  });

  it('downloads a repeated image once and validates all URLs before fetching', async () => {
    const image = `<img src="${resource}" width="10" height="10"/>`;
    const fetchResource = jest.fn().mockResolvedValue({ body: redSquare, contentType: 'image/png' });
    await renderOneNotePage(document(html(image + image)), '/me', fetchResource, deadline());
    expect(fetchResource).toHaveBeenCalledTimes(1);
    fetchResource.mockClear();
    await expect(renderOneNotePage(document(html(image + '<img src="https://attacker.example/a" width="10" height="10"/>')), '/me', fetchResource, deadline())).rejects.toThrow('graph.microsoft.com');
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it('rejects decompression-sized images before handing them to resvg', async () => {
    const huge = Buffer.from(redSquare);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    await expect(renderOneNotePage(document(html(`<img src="${resource}" width="100" height="100"/>`)), '/me', jest.fn().mockResolvedValue({ body: huge }), deadline())).rejects.toThrow('pixel budget');
  });

  it('rejects raw SVG resources and oversized files', async () => {
    const page = document(html(`<img src="${resource}" width="100" height="100"/>`));
    await expect(renderOneNotePage(page, '/me', jest.fn().mockResolvedValue({ body: Buffer.from('<svg/>') }), deadline())).rejects.toThrow('PNG or JPEG');
    await expect(renderOneNotePage(page, '/me', jest.fn().mockResolvedValue({ body: Buffer.alloc(4 * 1024 * 1024 + 1) }), deadline())).rejects.toThrow('4 MiB');
  });

  it('rejects a canvas beyond the tile budget and an expired deadline', async () => {
    await expect(renderOneNotePage(document(html(''), ink('0 0, 100000 100000')), '/me', jest.fn(), deadline())).rejects.toThrow('tile');
    await expect(renderOneNotePage(document(html('')), '/me', jest.fn(), Date.now() - 1)).rejects.toThrow('timed out');
  });

  it('keeps a text-only page useful and says that Graph returned no ink', async () => {
    const result = await renderOneNotePage(document(html('<p>Typed</p>')), '/me', jest.fn(), deadline());
    expect(result.text).toBe('Typed');
    expect(result.tiles).toEqual([]);
    expect(result.warnings).toEqual(['Graph returned no renderable ink or positioned images.']);
  });

  it('honors a smaller per-tool image limit', async () => {
    await expect(renderOneNotePage(document(html(''), ink('0 0, 10 10')), '/me', jest.fn(), deadline(), { maxTileBytes: 1 })).rejects.toThrow('output byte limit');
  });

  it('bounds concurrent previews and releases the slot after completion', async () => {
    let release!: (value: { body: Buffer; contentType: string }) => void;
    const response = new Promise<{ body: Buffer; contentType: string }>((resolve) => { release = resolve; });
    const fetchResource = jest.fn().mockReturnValue(response);
    const page = document(html(`<img src="${resource}" width="10" height="10"/>`));
    const first = renderOneNotePage(page, '/me', fetchResource, deadline());
    const second = renderOneNotePage(page, '/me', fetchResource, deadline());
    try {
      await expect(renderOneNotePage(page, '/me', fetchResource, deadline())).rejects.toThrow('busy');
    } finally {
      release({ body: redSquare, contentType: 'image/png' });
      await Promise.all([first, second]);
    }
    await expect(renderOneNotePage(page, '/me', fetchResource, deadline())).resolves.toMatchObject({ text: '' });
  });
});
