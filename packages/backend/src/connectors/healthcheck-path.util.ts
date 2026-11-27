import { getAdapter } from '../adapters/catalog';

/**
 * Where the path that "Test connection" calls came from.
 *
 *   connector — set on the connector (by the user, an OpenAPI import, or the
 *               catalog at install)
 *   catalog   — not set on the connector, taken from the adapter it was
 *               installed from
 *   default   — neither has one: the base URL itself ("/")
 */
export type HealthcheckPathSource = 'connector' | 'catalog' | 'default';

/**
 * The path a REST connector's connection test calls.
 *
 * The connector's own `healthcheckPath` wins. A catalog connector without one
 * falls back to its adapter's current path: the column is copied only at
 * install and the catalog re-sync never touches it, so a test path added to
 * an adapter later would otherwise never reach connectors installed before.
 * Instagram connectors called the bare Graph API base URL this way and Meta
 * answered every test with HTTP 400 "Unsupported get request".
 */
export function resolveHealthcheckPath(connector: {
  healthcheckPath?: string | null;
  config?: unknown;
}): { path: string; source: HealthcheckPathSource } {
  const own = connector.healthcheckPath?.trim();
  if (own) return { path: own, source: 'connector' };

  const slug = (connector.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  if (typeof slug === 'string' && slug) {
    const adapter = getAdapter(slug);
    const fromCatalog = (adapter?.connector as { healthcheckPath?: unknown } | undefined)
      ?.healthcheckPath;
    if (typeof fromCatalog === 'string' && fromCatalog.trim()) {
      return { path: fromCatalog.trim(), source: 'catalog' };
    }
  }
  return { path: '/', source: 'default' };
}
