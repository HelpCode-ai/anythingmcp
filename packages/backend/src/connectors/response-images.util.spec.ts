import { extractResponseImages, readImages, validateImages } from './response-images.util';
import { applyResponseTransform } from './response-transform.util';

// Smallest byte sequences each format is recognised by, padded to a few bytes.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000\u0000', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const b64 = (b: Buffer) => b.toString('base64');

const OPENAI = (items: string[]) => ({
  created: 1760000000,
  output_format: 'png',
  data: items.map((x) => ({ b64_json: x })),
  usage: { total_tokens: 1100 },
});

const GEMINI = (data: string, mimeType = 'image/png') => ({
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Here is your image.' }, { inlineData: { mimeType, data } }],
      },
      finishReason: 'STOP',
    },
  ],
  modelVersion: 'gemini-3.1-flash-lite-image',
});

const cfg = (paths: string[], extra: Partial<{ maxImages: number; maxBytes: number }> = {}) =>
  readImages({ images: { paths, ...extra } })!;

describe('validateImages', () => {
  it('accepts a path, a list of paths and the object form', () => {
    expect(validateImages(undefined)).toBeNull();
    expect(validateImages(null)).toBeNull();
    expect(validateImages('data[*].b64_json')).toBeNull();
    expect(validateImages(['data[*].b64_json', '$.image'])).toBeNull();
    expect(validateImages({ paths: ['candidates[*].content.parts[*].inlineData.data'], maxImages: 2, maxBytes: 1000 })).toBeNull();
  });

  it('refuses empty or malformed paths, unknown options and limits out of range', () => {
    expect(validateImages([])).toMatch(/1 to 10 paths/);
    expect(validateImages({})).toMatch(/1 to 10 paths/);
    expect(validateImages({ paths: [42] })).toMatch(/strings/);
    expect(validateImages({ paths: ['data[abc]'] })).toMatch(/index or \*/);
    expect(validateImages({ paths: ['data[0'] })).toMatch(/unclosed/);
    expect(validateImages({ paths: ['__proto__.x'] })).toMatch(/unsafe/);
    expect(validateImages({ paths: ['a'], decode: true })).toMatch(/unknown option "decode"/);
    expect(validateImages({ paths: ['a'], maxImages: 11 })).toMatch(/maxImages/);
    expect(validateImages({ paths: ['a'], maxBytes: 0 })).toMatch(/maxBytes/);
    expect(validateImages({ paths: ['a'], maxBytes: 9 * 1024 * 1024 })).toMatch(/maxBytes/);
  });

  it('defaults to 4 images of up to 4 MiB', () => {
    expect(readImages({ images: 'data[*].b64_json' })).toEqual({ paths: ['data[*].b64_json'], maxImages: 4, maxBytes: 4 * 1024 * 1024 });
    expect(readImages({})).toBeNull();
    expect(() => readImages({ images: [] })).toThrow(/paths/);
  });
});

describe('extractResponseImages', () => {
  it('takes OpenAI b64_json images out and leaves a placeholder, without touching the input', () => {
    const raw = OPENAI([b64(PNG), b64(JPEG)]);
    const frozen = JSON.stringify(raw);
    const out = extractResponseImages(raw, cfg(['data[*].b64_json']));
    expect(out.images).toEqual([
      { data: b64(PNG), mimeType: 'image/png', bytes: PNG.length },
      { data: b64(JPEG), mimeType: 'image/jpeg', bytes: JPEG.length },
    ]);
    const value = out.value as ReturnType<typeof OPENAI>;
    expect(value.data[0].b64_json).toMatch(/^\[image 1: image\/png, 1 KB, attached to this result as an image\]$/);
    expect(value.data[1].b64_json).toMatch(/^\[image 2: image\/jpeg/);
    expect(value.usage).toBe(raw.usage);
    expect(JSON.stringify(raw)).toBe(frozen);
  });

  it('reads Gemini inline data, trusting the bytes over the declared type', () => {
    const out = extractResponseImages(GEMINI(b64(WEBP), 'image/png'), cfg(['candidates[*].content.parts[*].inlineData.data']));
    expect(out.images.map((i) => i.mimeType)).toEqual(['image/webp']);
    const parts = (out.value as any).candidates[0].content.parts;
    expect(parts[0]).toEqual({ text: 'Here is your image.' });
    expect(parts[1].inlineData.data).toMatch(/^\[image 1: image\/webp/);
  });

  it('accepts base64url, missing padding and data URLs, and hands out standard base64', () => {
    const url = b64(GIF).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const out = extractResponseImages({ a: url, b: `data:image/png;base64,${b64(PNG)}` }, cfg(['a', 'b']));
    expect(out.images).toEqual([
      { data: b64(GIF), mimeType: 'image/gif', bytes: GIF.length },
      { data: b64(PNG), mimeType: 'image/png', bytes: PNG.length },
    ]);
  });

  it('never hands over something that is not an image, and drops it from the text too', () => {
    const notImage = Buffer.from('%PDF-1.7 not an image at all').toString('base64');
    const out = extractResponseImages({ a: notImage, b: 'hello, this is plain text!!', c: 42 }, cfg(['a', 'b', 'c']));
    expect(out.images).toEqual([]);
    expect((out.value as any).a).toMatch(/not a PNG, JPEG, GIF or WebP image/);
    expect((out.value as any).b).toMatch(/not a PNG, JPEG, GIF or WebP image/);
    expect((out.value as any).c).toBe(42);
  });

  it('enforces the per-image size and the image count', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3000)]);
    const out = extractResponseImages(OPENAI([b64(big), b64(PNG), b64(JPEG), b64(PNG)]), cfg(['data[*].b64_json'], { maxImages: 2, maxBytes: 2048 }));
    expect(out.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg']);
    const data = (out.value as any).data;
    expect(data[0].b64_json).toMatch(/image omitted: image\/png, 3 KB, above the 2 KB limit/);
    expect(data[1].b64_json).toMatch(/^\[image 1:/);
    expect(data[2].b64_json).toMatch(/^\[image 2:/);
    expect(data[3].b64_json).toMatch(/only the first 2 images/);
  });

  it('caps the images of one result at 12 MiB together', () => {
    const three = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const out = extractResponseImages(OPENAI([b64(three), b64(three), b64(three)]), cfg(['data[*].b64_json'], { maxBytes: 8 * 1024 * 1024 }));
    expect(out.images).toHaveLength(2);
    expect((out.value as any).data[2].b64_json).toMatch(/exceed 12\.0 MB together/);
  });

  it('returns the same object when nothing matches', () => {
    const raw = { error: { message: 'nope' } };
    const out = extractResponseImages(raw, cfg(['data[*].b64_json', 'candidates[0].content.parts[*].inlineData.data']));
    expect(out.value).toBe(raw);
    expect(out.images).toEqual([]);
  });
});

describe('applyResponseTransform with images', () => {
  it('keeps the no-op path for mappings without images', () => {
    const raw = OPENAI([b64(PNG)]);
    const outcome = applyResponseTransform(raw, { cacheTtl: 0 });
    expect(outcome.value).toBe(raw);
    expect(outcome.images).toBeUndefined();
  });

  it('extracts first, then runs the transform on the placeholders', () => {
    const outcome = applyResponseTransform(OPENAI([b64(PNG)]), {
      images: { paths: ['data[*].b64_json'] },
      transform: { select: { format: '$.output_format', images: '$.data[*].b64_json' } },
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.value).toEqual({ format: 'png', images: [expect.stringMatching(/^\[image 1: image\/png/)] });
    expect(outcome.images).toHaveLength(1);
  });

  it('marks images alone as applied, and keeps them when a transform fails and falls back', () => {
    const only = applyResponseTransform(OPENAI([b64(JPEG)]), { images: 'data[*].b64_json' });
    expect(only.applied).toBe(true);
    expect(only.images?.[0].mimeType).toBe('image/jpeg');

    const broken = applyResponseTransform(OPENAI([b64(JPEG)]), {
      images: 'data[*].b64_json',
      transform: { mode: 'jmespath', expression: 'data[' },
    });
    expect(broken.error).toBeDefined();
    expect(JSON.stringify(broken.value)).not.toContain(b64(JPEG));
    expect(broken.images).toHaveLength(1);
  });

  it('fails the call rather than leak base64 when the images config is invalid', () => {
    const raw = OPENAI([b64(PNG)]);
    const outcome = applyResponseTransform(raw, { images: { paths: [] } });
    expect(outcome.fatal).toBe(true);
    expect(outcome.error).toMatch(/paths/);
  });
});
