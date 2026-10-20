import {
  BINARY_MARKER,
  DEFAULT_MAX_BINARY_BYTES,
  HARD_MAX_BINARY_BYTES,
  decodeResponseBody,
  dispositionFilename,
  isBinaryBody,
  readBinaryConfig,
  renderBinaryBody,
  validateBinaryConfig,
  withoutBinaryData,
  type BinaryBody,
} from './binary-response.util';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n')]);

const h = (contentType?: string, disposition?: string) => ({
  ...(contentType ? { 'content-type': contentType } : {}),
  ...(disposition ? { 'content-disposition': disposition } : {}),
});

describe('decodeResponseBody', () => {
  it('parses JSON exactly as axios did', () => {
    expect(decodeResponseBody(Buffer.from('{"ok":true,"n":[1,2]}'), h('application/json'))).toEqual({ ok: true, n: [1, 2] });
    // axios parsed any body that is JSON, whatever the content type said.
    expect(decodeResponseBody(Buffer.from('[1]'), h('text/plain'))).toEqual([1]);
    expect(decodeResponseBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it('keeps text and XML as strings, and an empty body as ""', () => {
    expect(decodeResponseBody(Buffer.from('hello'), h('text/plain; charset=utf-8'))).toBe('hello');
    expect(decodeResponseBody(Buffer.from('<a>1</a>'), h('application/xml'))).toBe('<a>1</a>');
    expect(decodeResponseBody(Buffer.from('<svg/>'), h('image/svg+xml'))).toBe('<svg/>');
    expect(decodeResponseBody(Buffer.from('<html>'), h('text/html'))).toBe('<html>');
    expect(decodeResponseBody(Buffer.alloc(0), h('image/png'))).toBe('');
  });

  it('decodes text sent as application/octet-stream or with no content type', () => {
    expect(decodeResponseBody(Buffer.from('plain words\nline 2'), h('application/octet-stream'))).toBe('plain words\nline 2');
    expect(decodeResponseBody(Buffer.from('ünïcödé'))).toBe('ünïcödé');
  });

  it('turns an image, a PDF and non-UTF-8 bytes into a binary body', () => {
    const png = decodeResponseBody(PNG, h('image/png')) as BinaryBody;
    expect(png).toEqual({ [BINARY_MARKER]: 1, contentType: 'image/png', bytes: PNG.length, base64: PNG.toString('base64') });

    const pdf = decodeResponseBody(PDF, h('application/pdf', 'attachment; filename="invoice 12.pdf"')) as BinaryBody;
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.filename).toBe('invoice 12.pdf');
    expect(Buffer.from(pdf.base64, 'base64').equals(PDF)).toBe(true);

    // Telegram serves files as application/octet-stream.
    const jpeg = decodeResponseBody(JPEG, h('application/octet-stream')) as BinaryBody;
    expect(isBinaryBody(jpeg)).toBe(true);
    expect(jpeg.contentType).toBe('application/octet-stream');
  });

  it('treats text-free control bytes under a generic type as binary', () => {
    const body = decodeResponseBody(Buffer.from([0x00, 0x01, 0x02, 0x41]), h('application/octet-stream'));
    expect(isBinaryBody(body)).toBe(true);
  });

  it('reads AxiosHeaders-style objects with get()', () => {
    const headers = { get: (n: string) => (n === 'content-type' ? 'image/png' : undefined) };
    expect(isBinaryBody(decodeResponseBody(PNG, headers))).toBe(true);
  });

  it('passes through what is not a buffer', () => {
    expect(decodeResponseBody('{"a":1}')).toEqual({ a: 1 });
    expect(decodeResponseBody(undefined)).toBeUndefined();
  });
});

describe('dispositionFilename', () => {
  it('reads filename and filename*, and keeps only the base name', () => {
    expect(dispositionFilename('attachment; filename="a.pdf"')).toBe('a.pdf');
    expect(dispositionFilename('inline; filename=b.jpg')).toBe('b.jpg');
    expect(dispositionFilename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
    expect(dispositionFilename('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(dispositionFilename('attachment')).toBeUndefined();
    expect(dispositionFilename('')).toBeUndefined();
  });
});

describe('renderBinaryBody', () => {
  const body = (buf: Buffer, contentType: string, filename?: string): BinaryBody => ({
    [BINARY_MARKER]: 1,
    contentType,
    bytes: buf.length,
    ...(filename ? { filename } : {}),
    base64: buf.toString('base64'),
  });
  const auto = readBinaryConfig(undefined);

  it('hands an image over as image content, sniffed from its bytes', () => {
    const out = renderBinaryBody(body(JPEG, 'application/octet-stream'), auto);
    expect(out.content).toEqual([{ type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' }]);
    expect(JSON.stringify(out.value)).not.toContain(JPEG.toString('base64'));
    expect(out.value.file).toMatchObject({ contentType: 'application/octet-stream', bytes: JPEG.length });
  });

  it('hands any other file over as an embedded resource with its type', () => {
    const out = renderBinaryBody(body(PDF, 'application/pdf', 'invoice.pdf'), auto);
    expect(out.content).toEqual([
      { type: 'resource', resource: { uri: 'file:///invoice.pdf', mimeType: 'application/pdf', blob: PDF.toString('base64') } },
    ]);
    expect(out.value.file).toMatchObject({ filename: 'invoice.pdf' });
  });

  it('describes a file over the limit and attaches nothing', () => {
    const out = renderBinaryBody(body(PDF, 'application/pdf'), { as: 'auto', maxBytes: 4 });
    expect(out.content).toEqual([]);
    expect(String(out.value.note)).toMatch(/over this tool's limit/);
  });

  it('puts the base64 in the text with as: base64', () => {
    const out = renderBinaryBody(body(PNG, 'image/png'), readBinaryConfig({ binary: { as: 'base64' } }));
    expect(out.content).toEqual([]);
    expect((out.value.file as Record<string, unknown>).base64).toBe(PNG.toString('base64'));
  });
});

describe('binary config', () => {
  it('defaults and caps', () => {
    expect(readBinaryConfig(null)).toEqual({ as: 'auto', maxBytes: DEFAULT_MAX_BINARY_BYTES });
    expect(readBinaryConfig({ binary: { maxBytes: 10 ** 9 } }).maxBytes).toBe(HARD_MAX_BINARY_BYTES);
  });

  it('refuses malformed settings at save time', () => {
    expect(validateBinaryConfig(undefined)).toBeNull();
    expect(validateBinaryConfig({ as: 'auto', maxBytes: 1024 })).toBeNull();
    expect(validateBinaryConfig('x')).toMatch(/object/);
    expect(validateBinaryConfig({ as: 'hex' })).toMatch(/binary.as/);
    expect(validateBinaryConfig({ maxBytes: 0 })).toMatch(/maxBytes/);
    expect(validateBinaryConfig({ maxBytes: HARD_MAX_BINARY_BYTES + 1 })).toMatch(/maxBytes/);
    expect(validateBinaryConfig({ size: 1 })).toMatch(/unknown key/);
  });
});

describe('withoutBinaryData', () => {
  it('drops the bytes of a binary body and leaves anything else alone', () => {
    const b = decodeResponseBody(PNG, h('image/png')) as BinaryBody;
    const stripped = withoutBinaryData(b);
    expect(stripped.base64).toMatch(/binary data not stored/);
    expect(stripped.bytes).toBe(PNG.length);
    expect(b.base64).toBe(PNG.toString('base64'));
    const other = { a: 1 };
    expect(withoutBinaryData(other)).toBe(other);
  });
});
