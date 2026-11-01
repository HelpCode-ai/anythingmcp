import { CODE_EXTENSIONS, TEXT_EXTENSIONS, TYPE_GROUPS } from './file-search.types';

describe('file-search types', () => {
  it('labels every extension whose text is read', () => {
    expect([...TEXT_EXTENSIONS].filter((ext) => !TYPE_GROUPS[ext])).toEqual([]);
  });

  it('uses lower-case extensions with a leading dot', () => {
    expect([...TEXT_EXTENSIONS].filter((ext) => !/^\.[a-z0-9]+$/.test(ext))).toEqual([]);
  });

  it('reads Office variants, e-books, drawings, mailboxes and code as text', () => {
    for (const ext of ['.docm', '.dotx', '.xltx', '.xlsb', '.pptm', '.ppsx', '.potx', '.ott', '.epub', '.xps', '.svg', '.dxf', '.mbox', '.pages', '.yaml', '.sql', '.py', '.ts']) {
      expect(TEXT_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(TYPE_GROUPS['.py']).toBe('Code');
    expect(CODE_EXTENSIONS).toContain('.yaml');
  });

  it('leaves formats without a reader to name-only search', () => {
    for (const ext of ['.dwg', '.zip', '.png', '.exe']) expect(TEXT_EXTENSIONS.has(ext)).toBe(false);
  });
});
