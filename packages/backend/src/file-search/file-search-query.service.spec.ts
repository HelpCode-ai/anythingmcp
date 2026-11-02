import { Prisma } from '../generated/prisma/client';
import { FileSearchQueryService, aggregateTree, parsePages, relPath, scopeSql } from './file-search-query.service';

describe('File Search query helpers', () => {
  it('parses page lists', () => {
    expect(parsePages('3, 1-2,7')).toEqual([1, 2, 3, 7]);
    expect(parsePages('x')).toBeUndefined();
    expect(parsePages('1-500')).toHaveLength(50);
  });

  it('never lets a relative path climb out', () => {
    expect(relPath('/a/../b/./c/')).toBe('a/b/c');
    expect(relPath(undefined)).toBe('');
  });

  it('always scopes by organization and connector, then by folder rules', () => {
    const sql = scopeSql('e', { organizationId: 'org1', connectorId: 'c1', allow: ['Einkauf'], deny: ['Einkauf/Intern'] }, 'Einkauf') as Prisma.Sql;
    expect(sql.sql).toContain('e.organization_id = ?');
    expect(sql.sql).toContain('e.connector_id = ?');
    expect(sql.sql).toContain('NOT (');
    expect(sql.values).toEqual(expect.arrayContaining(['org1', 'c1', 'Einkauf/%', 'Einkauf/Intern/%']));
  });

  it('builds a folder tree with counts that include subfolders', () => {
    const t = aggregateTree([{ dir: '', files: 2, bytes: 10 }, { dir: 'A/B', files: 3, bytes: 30 }, { dir: 'A', files: 1, bytes: 5 }], 3);
    expect(t.files).toBe(6);
    expect(t.children[0]).toMatchObject({ name: 'A', files: 4, bytes: 35 });
    expect(t.children[0].children[0]).toMatchObject({ path: 'A/B', files: 3 });
  });

  it('falls back to words in the path, then to any word, when no page has all the words', async () => {
    const calls: string[] = [];
    const hit = { id: 1n, entry_id: 'e1', page: 2, rank: 0.5, path: 'Nordtor/Preisliste/p.xlsx', name: 'p.xlsx', ext: '.xlsx', size: 10n, mtime: new Date('2026-01-01'), page_count: 3 };
    const tx = {
      $queryRaw: jest.fn(async (q: Prisma.Sql) => {
        const sql = q.sql;
        calls.push(sql);
        if (sql.includes('ts_headline')) return [{ id: 1n, snippet: 'Brandschutztür T30' }];
        if (sql.includes('FROM file_chunks c') && sql.includes('ILIKE')) return [hit];
        return [];
      }),
    };
    const svc = new FileSearchQueryService({ withTenant: (_o: string, fn: any) => fn(tx) } as any);
    const r: any = await svc.search({ organizationId: 'o', connectorId: 'c' }, { query: 'Preisliste Brandschutztür' } as any);
    expect(r.match).toBe('words_in_text_or_path');
    expect(r.files[0]).toMatchObject({ path: 'Nordtor/Preisliste/p.xlsx', page: 2 });
    // A quoted phrase is taken literally: no fallback.
    calls.length = 0;
    const exact: any = await svc.search({ organizationId: 'o', connectorId: 'c' }, { query: '"Preisliste Brandschutztür"' } as any);
    expect(exact.total).toBe(0);
    expect(exact.match).toBeUndefined();
    expect(calls.filter((c) => c.includes('FROM file_chunks c') && !c.includes('ts_headline'))).toHaveLength(1);
  });
});

