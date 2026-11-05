import { getAdapter } from '../adapters/catalog';

/**
 * Headers for an outgoing request, with the catalog adapter's User-Agent added
 * when the connector itself has none.
 *
 * Some APIs ask integrators to identify themselves on every call (sevdesk's
 * technology partner programme requires it). The adapter JSON carries that
 * header, but it is copied onto a connector only at install, and catalog sync
 * never touches stored headers (catalog-resync.service.ts). Connectors
 * installed before the adapter gained the header would keep sending none, so
 * the catalog value is applied here, at request time.
 *
 * Only a static template value is used (no `{{VAR}}`): a templated header may
 * carry a secret or a per-connector value. A User-Agent stored on the
 * connector always wins, whatever its case. Hand-made connectors (no
 * `adapterSlug`) are left as they are.
 */
export function withCatalogUserAgent(
  headers: Record<string, string> | undefined,
  connectorConfig: unknown,
): Record<string, string> | undefined {
  const slug = (connectorConfig as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  if (typeof slug !== 'string' || !slug) return headers;
  if (headers && Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    return headers;
  }
  const template = getAdapter(slug)?.connector.headers;
  if (!template) return headers;
  const entry = Object.entries(template).find(([name]) => name.toLowerCase() === 'user-agent');
  if (!entry) return headers;
  const [name, value] = entry;
  if (typeof value !== 'string' || !value.trim() || value.includes('{{')) return headers;
  return { ...(headers ?? {}), [name]: value };
}
