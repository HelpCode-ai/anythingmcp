/**
 * Where a File Search catalog entry is set up: the File Search wizard, with
 * the protocol and, for a product, its preset preselected. The dashboard
 * builds the same path in packages/frontend/src/lib/file-search-catalog.ts.
 *
 * File Search connectors are never installed directly (importAdapter refuses
 * them): the wizard tests the connection, scans the folder and checks it
 * against the plan first.
 */

/** Catalog entries for a product, and the wizard preset that fills in its port or address. */
const PRESETS: Record<string, string> = {
  'nextcloud-file-search': 'nextcloud',
  'owncloud-file-search': 'owncloud',
  'synology-file-search': 'synology',
  'qnap-file-search': 'qnap',
  'fritzbox-file-search': 'fritzbox',
  'hetzner-storage-box': 'hetzner',
};

interface FileSearchAdapterLike {
  slug: string;
  connector: { type: string; config?: unknown };
}

export function isFileSearchAdapter(adapter: FileSearchAdapterLike): boolean {
  return (adapter.connector.type as string) === 'FILE_SEARCH';
}

/**
 * The wizard path for a File Search entry, or null for any other adapter.
 * `adapter` names the entry for the wizard's product events, `from` where
 * the link was given ('chat').
 */
export function fileSearchSetupPath(adapter: FileSearchAdapterLike, from?: string): string | null {
  if (!isFileSearchAdapter(adapter)) return null;
  const protocol =
    (adapter.connector.config as { fileSearch?: { protocol?: string } } | undefined)?.fileSearch?.protocol ?? 'sftp';
  const q = new URLSearchParams({ protocol });
  const preset = PRESETS[adapter.slug];
  if (preset) q.set('preset', preset);
  q.set('adapter', adapter.slug);
  if (from) q.set('from', from);
  return `/connectors/new/file-search?${q.toString()}`;
}
