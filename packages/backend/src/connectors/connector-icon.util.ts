import { listAdapters, getAdapter } from '../adapters/catalog';

/**
 * Resolve the adapter icon for a given Connector row.
 *
 * Preference order:
 *   1. `connector.config.adapterSlug` (set at import time by AdaptersService)
 *      — survives connector renames.
 *   2. Reverse lookup by `connector.name`. Works for connectors created
 *      before adapterSlug tracking was added, and for any future import
 *      that forgets to set the slug. Renaming the connector breaks this
 *      fallback (the UI gracefully degrades to the generic type badge).
 *
 * Returns the adapter's `icon` field (e.g. "wordpress", "woocommerce")
 * which the frontend maps to `/logos/connectors/<icon>.svg`. Returns null
 * if no match.
 */

// Built once at module load. Module-level so we don't iterate the catalog
// on every request.
const nameToIcon: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const meta of listAdapters()) {
    const adapter = getAdapter(meta.slug);
    if (!adapter?.icon) continue;
    const connName = (adapter.connector as { name?: string }).name;
    if (connName && !map.has(connName)) {
      map.set(connName, adapter.icon);
    }
  }
  return map;
})();

export function resolveAdapterIcon(connector: {
  name: string;
  config?: unknown;
}): string | null {
  // 1) Explicit slug from config (set at import time)
  const cfg = connector.config as Record<string, unknown> | null | undefined;
  const slugFromConfig = cfg && typeof cfg.adapterSlug === 'string' ? cfg.adapterSlug : null;
  if (slugFromConfig) {
    const adapter = getAdapter(slugFromConfig);
    if (adapter?.icon) return adapter.icon;
  }
  // 2) Fallback: name match
  return nameToIcon.get(connector.name) ?? null;
}
