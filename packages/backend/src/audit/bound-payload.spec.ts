import { boundPayload, boundText, TRUNCATION_MARKER } from './bound-payload';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('boundPayload', () => {
  it('returns small values untouched (same reference)', () => {
    const v = { id: 1, name: 'x' };
    expect(boundPayload(v, { maxBytes: 1024 })).toBe(v);
    expect(boundPayload(undefined, { maxBytes: 10 })).toBeUndefined();
  });

  it('keeps the structure, field names and first values of a large response', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ customer_id: `C${i}`, name: `Customer ${i}`, notes: 'x'.repeat(300) }));
    const big = { total: 5000, items: rows };
    const out = boundPayload(big, { maxBytes: 16 * 1024 }) as any;
    expect(size(out)).toBeLessThanOrEqual(16 * 1024);
    expect(out[TRUNCATION_MARKER].originalBytes).toBe(size(big));
    expect(out.total).toBe(5000);
    expect(out.items[0].customer_id).toBe('C0');
    expect(Object.keys(out.items[0])).toEqual(['customer_id', 'name', 'notes']);
    expect(out.items[out.items.length - 1]).toMatch(/more items$/);
  });

  it('wraps a top-level array', () => {
    const arr = Array.from({ length: 2000 }, (_, i) => ({ i, s: 'y'.repeat(50) }));
    const out = boundPayload(arr, { maxBytes: 4096 }) as any;
    expect(size(out)).toBeLessThanOrEqual(4096);
    expect(Array.isArray(out.value)).toBe(true);
    expect(out.value[0].i).toBe(0);
  });

  it('falls back to a text excerpt for pathological shapes', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) wide[`field_${i}`] = 'v';
    const out = boundPayload(wide, { maxBytes: 2048 }) as any;
    expect(size(out)).toBeLessThanOrEqual(2048);
    expect(typeof out.excerpt).toBe('string');
  });

  it('shortens long error text', () => {
    expect(boundText('short', 10)).toBe('short');
    expect(boundText('a'.repeat(50), 10)).toMatch(/^a{10}… \[truncated, 50 chars\]$/);
    expect(boundText(undefined, 10)).toBeUndefined();
  });
});
