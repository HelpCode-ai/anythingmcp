import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { RestEngine } from './rest.engine';
import { isBinaryBody, type BinaryBody } from '../binary-response.util';

/**
 * Binary bodies with the real axios and a real socket. A file downloaded by a
 * REST tool used to be decoded as UTF-8 text, which corrupts it (support #108:
 * Telegram's /file/bot<token>/<path> answers application/octet-stream).
 */
describe('RestEngine binary responses on the wire', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x80]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\nxref\n')]);

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case '/json':
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.end('{"ok":true,"result":{"file_path":"photos/file_1.jpg"}}');
        case '/gzip-json':
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Encoding', 'gzip');
          return res.end(gzipSync('{"zipped":true}'));
        case '/text':
          res.setHeader('Content-Type', 'text/plain');
          return res.end('plain text ✓');
        case '/xml':
          res.setHeader('Content-Type', 'application/xml');
          return res.end('<root><a>1</a></root>');
        case '/png':
          res.setHeader('Content-Type', 'image/png');
          return res.end(PNG);
        case '/file/botTOKEN/photos/file_1.jpg':
          res.setHeader('Content-Type', 'application/octet-stream');
          return res.end(JPEG);
        case '/pdf':
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="invoice.pdf"');
          return res.end(PDF);
        case '/missing':
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          return res.end('{"ok":false,"error_code":404,"description":"Not Found"}');
        default:
          res.statusCode = 500;
          return res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const engine = new RestEngine({} as any, {} as any);
  const get = (path: string) => engine.execute({ baseUrl, authType: 'NONE' }, { method: 'GET', path }, {});

  it('still parses JSON, gzipped JSON, text and XML as before', async () => {
    await expect(get('/json')).resolves.toEqual({ ok: true, result: { file_path: 'photos/file_1.jpg' } });
    await expect(get('/gzip-json')).resolves.toEqual({ zipped: true });
    await expect(get('/text')).resolves.toBe('plain text ✓');
    await expect(get('/xml')).resolves.toEqual({ root: { a: '1' } });
  });

  it('returns an image with its exact bytes', async () => {
    const body = (await get('/png')) as BinaryBody;
    expect(isBinaryBody(body)).toBe(true);
    expect(body.contentType).toBe('image/png');
    expect(Buffer.from(body.base64, 'base64').equals(PNG)).toBe(true);
  });

  it('returns a Telegram file download (octet-stream) uncorrupted', async () => {
    const body = (await get('/file/botTOKEN/photos/file_1.jpg')) as BinaryBody;
    expect(isBinaryBody(body)).toBe(true);
    expect(body.bytes).toBe(JPEG.length);
    expect(Buffer.from(body.base64, 'base64').equals(JPEG)).toBe(true);
  });

  it('keeps the file name of a PDF', async () => {
    const body = (await get('/pdf')) as BinaryBody;
    expect(body).toMatchObject({ contentType: 'application/pdf', filename: 'invoice.pdf', bytes: PDF.length });
    expect(Buffer.from(body.base64, 'base64').equals(PDF)).toBe(true);
  });

  it('still hands a JSON error body to the error handling', async () => {
    await expect(get('/missing')).rejects.toMatchObject({
      response: { status: 404, data: { ok: false, description: 'Not Found' } },
    });
  });
});
