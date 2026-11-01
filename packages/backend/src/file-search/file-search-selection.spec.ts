import { applySelection, buildFilter, checkQuota, estimate, selectionOf, type CompactListing } from './file-search-selection';
import type { FileSearchConfig } from './file-search.types';

const cfg = (over: Partial<FileSearchConfig> = {}): FileSearchConfig => ({ protocol: 'sftp', rootPath: '/', include: ['**/*'], exclude: [], maxDepth: 32, maxConnections: 1, toolPrefix: 'x', ...over });
const day = (iso: string) => Math.floor(new Date(iso).getTime() / 86400000);

describe('selection', () => {
  const listing: CompactListing = {
    dirs: ['', 'Nordtor - 70100/Preisliste', 'Nordtor - 70100/Preisliste/Alt', 'Kessler - 70107'],
    exts: ['.pdf', '.xlsx', '.png'],
    entries: [
      [1, 0, 1000, day('2026-02-01'), 0],
      [1, 1, 2000, day('2026-03-01'), 0],
      [2, 1, 3000, day('2021-03-01'), 0],
      [3, 2, 500, day('2025-01-01'), 1],
      [0, 0, 999999999, day('2026-01-01'), 0],
    ],
  };

  it('round-trips the wizard selection through the settings', () => {
    const c = applySelection(cfg(), { excludeFolders: ['/Nordtor - 70100/Preisliste/Alt/'], extensions: ['pdf'], maxAgeYears: 2 });
    expect(c.exclude).toEqual(['Nordtor - 70100/Preisliste/Alt/**']);
    expect(selectionOf(c)).toEqual({ excludeFolders: ['Nordtor - 70100/Preisliste/Alt'], extensions: ['.pdf'], maxAgeYears: 2 });
  });

  it('counts what a selection would index', () => {
    const all = estimate(listing, cfg(), 10 * 1024 * 1024, new Date('2026-11-01'));
    expect(all).toMatchObject({ files: 5, textFiles: 3, nameOnly: 1, tooLarge: 1 });
    const noArchive = estimate(listing, applySelection(cfg(), { excludeFolders: ['Nordtor - 70100/Preisliste/Alt'] }), 10 * 1024 * 1024, new Date('2026-11-01'));
    expect(noArchive.files).toBe(4);
    const recentPdf = estimate(listing, applySelection(cfg(), { excludeFolders: [], extensions: ['.pdf'], maxAgeYears: 1 }), 10 * 1024 * 1024, new Date('2026-11-01'));
    expect(recentPdf.files).toBe(2);
  });

  it('never walks junk or excluded folders', () => {
    const f = buildFilter(applySelection(cfg(), { excludeFolders: ['a/Alt'] }));
    expect(f.dir('a/Alt')).toBe(false);
    expect(f.dir('a/alt/x')).toBe(false);
    expect(f.dir('@eaDir')).toBe(false);
    expect(f.file('a/~$lock.docx', null)).toBe(false);
    expect(f.dir('a/Altdorf')).toBe(true);
  });

  it('checks the quota across all connectors of the workspace', () => {
    expect(checkQuota({ files: 340, bytes: 1 }, 500, null, { files: 100, bytes: 0 }).fits).toBe(true);
    const over = checkQuota({ files: 340, bytes: 1 }, 500, null, { files: 200, bytes: 0 });
    expect(over).toEqual({ fits: false, over: [{ limit: 'files', used: 540, max: 500 }] });
    expect(checkQuota({ files: 10, bytes: 2_000 }, null, 1_000).over[0].limit).toBe('bytes');
  });
});
