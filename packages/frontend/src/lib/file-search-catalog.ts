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

/**
 * Where the wizard was opened from, sent with file_search_wizard_opened:
 * a card of the store or /welcome, the File Search hint under their search
 * box, the File Search card of Connectors → New, a link from a chat, or the
 * File Search plugin's setup page after approving an AI client ('authorize').
 */
export const FILE_SEARCH_ENTRY_POINTS = ['store', 'welcome', 'store_hint', 'welcome_hint', 'connectors_new', 'chat', 'authorize'] as const;
export type FileSearchEntryPoint = (typeof FILE_SEARCH_ENTRY_POINTS)[number];

/**
 * The wizard path for a File Search catalog entry, or null for any other
 * slug. `adapter` names the entry for the wizard's product events; `from`
 * says where the link was. The backend builds the same path for the chat
 * (packages/backend/src/adapters/file-search-setup.ts).
 */
export function fileSearchSetupPath(slug: string, from?: FileSearchEntryPoint): string | null {
  const entry = FILE_SEARCH_SLUGS[slug];
  if (!entry) return null;
  const q = new URLSearchParams({ protocol: entry.protocol });
  if (entry.preset) q.set('preset', entry.preset);
  q.set('adapter', slug);
  if (from) q.set('from', from);
  return `/connectors/new/file-search?${q.toString()}`;
}

/** Whether a catalog slug is a File Search entry (opens the wizard, not the generic setup). */
export function isFileSearchSlug(slug: string): boolean {
  return slug in FILE_SEARCH_SLUGS;
}

/**
 * A file count, coarse enough to say nothing about one workspace: the size
 * of a folder for the File Search funnel, never the number itself. The
 * backend keeps only these values (FILE_COUNT_BUCKETS in product-event.service.ts).
 */
export function fileCountBucket(files: number): string {
  if (!Number.isFinite(files) || files <= 0) return '0';
  if (files <= 100) return '1-100';
  if (files <= 500) return '101-500';
  if (files <= 2000) return '501-2000';
  if (files <= 10000) return '2001-10000';
  if (files <= 100000) return '10001-100000';
  return '100001+';
}
