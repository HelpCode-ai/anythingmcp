import { FileSearchConfigError, displayAddress, normalizeRelPath, parseFileSearchConfig, pickSecrets, toolPrefixFrom } from './file-search-config';

describe('parseFileSearchConfig', () => {
  const base = { cloud: false, localRoots: ['/mnt/share'] };

  it('accepts SFTP with defaults and derives the tool prefix from the name', () => {
    const c = parseFileSearchConfig({ protocol: 'sftp', host: 'Files.Example.com', username: 'u', rootPath: 'Preise/2026/' }, { ...base, connectorName: 'Supplier price lists' });
    expect(c).toMatchObject({ protocol: 'sftp', host: 'files.example.com', port: 22, rootPath: '/Preise/2026', toolPrefix: 'supplier_price_lists', maxDepth: 32 });
    expect(displayAddress(c)).toBe('sftp://files.example.com:22/Preise/2026');
  });

  it('refuses a network folder on the Cloud and outside FILE_SOURCE_ROOTS', () => {
    expect(() => parseFileSearchConfig({ protocol: 'local', rootPath: '/mnt/share/a' }, { cloud: true })).toThrow(FileSearchConfigError);
    expect(() => parseFileSearchConfig({ protocol: 'local', rootPath: '/etc' }, base)).toThrow(/inside one of the allowed folders/);
    expect(parseFileSearchConfig({ protocol: 'local', rootPath: '/mnt/share/a' }, base).rootPath).toBe('/mnt/share/a');
  });

  it('needs an explicit acknowledgement for plain FTP', () => {
    expect(() => parseFileSearchConfig({ protocol: 'ftp', host: 'h.example', username: 'u' }, base)).toThrow(/unencrypted/);
    expect(parseFileSearchConfig({ protocol: 'ftp', host: 'h.example', username: 'u', allowPlainFtp: true }, base).allowPlainFtp).toBe(true);
  });

  it('rejects path traversal and credentials in a WebDAV address', () => {
    expect(() => normalizeRelPath('a/../../etc')).toThrow(/\.\./);
    expect(() => parseFileSearchConfig({ protocol: 'webdav', url: 'https://u:p@dav.example/x/', username: 'u' }, base)).toThrow(/own fields/);
    expect(() => parseFileSearchConfig({ protocol: 'webdav', url: 'http://dav.example/', username: 'u' }, { cloud: true })).toThrow(/https/);
  });

  it('normalises TLS fingerprints and keeps only known secrets', () => {
    const c = parseFileSearchConfig({ protocol: 'ftps', host: 'nas.example', username: 'u', tlsFingerprintSha256: 'AB:CD:EF' }, base);
    expect(c.tlsFingerprintSha256).toBe('abcdef');
    expect(pickSecrets({ password: 'x', evil: 'y', privateKey: '' })).toEqual({ password: 'x' });
  });

  it('builds safe tool prefixes', () => {
    expect(toolPrefixFrom('Lieferanten Preislisten')).toBe('lieferanten_preislisten');
    expect(toolPrefixFrom('2026 Preise')).toBe('files_2026_preise');
    expect(toolPrefixFrom('')).toBe('files');
  });
});
