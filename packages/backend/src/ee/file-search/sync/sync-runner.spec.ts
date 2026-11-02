// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { toChunks } from './sync-runner';

describe('toChunks', () => {
  it('keeps pages as chunks and splits long ones on line breaks', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sheet "Preise" row ${i}: Artikel=NO-${i} · Preis=${i}`).join('\n');
    const chunks = toChunks([{ page: 1, text: 'short page' }, { page: 2, text: long }, { page: 3, text: '   ' }]);
    expect(chunks[0]).toEqual({ page: 1, content: 'short page' });
    const p2 = chunks.filter((c) => c.page === 2);
    expect(p2.length).toBeGreaterThan(1);
    expect(p2.every((c) => c.content.length <= 8000)).toBe(true);
    expect(p2.every((c) => c.content.startsWith('Sheet'))).toBe(true);
    expect(chunks.some((c) => c.page === 3)).toBe(false);
  });

  it('removes NUL characters Postgres cannot store', () => {
    expect(toChunks([{ page: null, text: 'a\u0000b' }])[0].content).toBe('ab');
  });
});
