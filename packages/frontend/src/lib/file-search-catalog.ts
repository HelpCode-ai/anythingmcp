/**
 * Catalog entries that are File Search connectors (#1379). They are never
 * installed by the generic setup: the store and /connectors/setup/<slug>
 * send them to the File Search wizard with the protocol (and, for a product,
 * its preset: port, WebDAV address) preselected.
 */
const FILE_SEARCH_SLUGS: Record<string, { protocol: string; preset?: string }> = {
  sftp: { protocol: 'sftp' },
  ftp: { protocol: 'ftps' },
  webdav: { protocol: 'webdav' },
  'network-folder': { protocol: 'local' },
  's3-file-search': { protocol: 's3' },
  'nextcloud-file-search': { protocol: 'webdav', preset: 'nextcloud' },
  'owncloud-file-search': { protocol: 'webdav', preset: 'owncloud' },
  'synology-file-search': { protocol: 'sftp', preset: 'synology' },
  'qnap-file-search': { protocol: 'sftp', preset: 'qnap' },
  'fritzbox-file-search': { protocol: 'ftps', preset: 'fritzbox' },
  'hetzner-storage-box': { protocol: 'sftp', preset: 'hetzner' },
};

export function fileSearchSetupPath(slug: string): string | null {
  const entry = FILE_SEARCH_SLUGS[slug];
  if (!entry) return null;
  return `/connectors/new/file-search?protocol=${entry.protocol}${entry.preset ? `&preset=${entry.preset}` : ''}`;
}
