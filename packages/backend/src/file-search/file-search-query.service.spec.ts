import { Prisma } from '../generated/prisma/client';
import { aggregateTree, parsePages, relPath, scopeSql } from './file-search-query.service';

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
});
