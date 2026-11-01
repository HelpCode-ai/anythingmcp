/**
 * Catalog entries that are File Search connectors (#1379). They are never
 * installed by the generic setup: the store and /connectors/setup/<slug>
 * send them to the File Search wizard with the protocol preselected.
 */
const FILE_SEARCH_SLUGS: Record<string, string> = {
  sftp: 'sftp',
  ftp: 'ftps',
  webdav: 'webdav',
  'network-folder': 'local',
};

export function fileSearchSetupPath(slug: string): string | null {
  const protocol = FILE_SEARCH_SLUGS[slug];
  return protocol ? `/connectors/new/file-search?protocol=${protocol}` : null;
}
