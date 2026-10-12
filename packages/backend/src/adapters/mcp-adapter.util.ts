import { getAdapter, type AdapterDefinition } from './catalog';
import type { DiscoveredMcpTool } from '../connectors/connectors.service';
import { localMcpToolName, mcpToolPrefixOf } from '../connectors/mcp-connector-config.util';

type CatalogTool = AdapterDefinition['tools'][number];

/**
 * The tools to install for a catalog adapter that bridges a vendor's own MCP
 * server (connector type MCP).
 *
 * The server is the authority on which tools exist and what they take: a
 * workspace on an older or newer server version gets exactly the tools that
 * version has. The catalog's list is a snapshot, used for the listing and as
 * the fallback when the server cannot be reached at install. What the catalog
 * adds on top is policy: a tool it marks `enabled: false` (a write a
 * workspace should opt into) installs switched off, and annotations it sets
 * fill in what the server leaves out.
 *
 * Tools the server has and the catalog does not know are installed as the
 * server describes them; catalog tools the server no longer has are left out.
 *
 * With a `prefix` (the adapter's `config.mcpToolPrefix`) each tool is named
 * `<prefix><remote name>` here and still called by its remote name, so two
 * bridges with a `list_issues` each can share an MCP server. Catalog entries
 * are matched by that local name, or by the remote name they call.
 *
 * A vendor server that is a gateway over several backends may list a tool
 * under a namespace the catalog's snapshot does not carry: TradingView's
 * lists `get_ohlcv` as `mcp-tv-get-ohlcv`. See namespacedCatalogMatches.
 */
export function mergeDiscoveredMcpTools(
  catalogTools: CatalogTool[],
  discovered: DiscoveredMcpTool[],
  prefix?: string,
): CatalogTool[] {
  const byName = new Map(catalogTools.map((t) => [t.name, t]));
  const byMethod = new Map(
    catalogTools
      .filter((t) => typeof t.endpointMapping?.method === 'string')
      .map((t) => [String(t.endpointMapping.method), t]),
  );
  const exact = (d: DiscoveredMcpTool) =>
    byName.get(localMcpToolName(d.name, prefix)) ?? byMethod.get(d.name);
  const namespaced = namespacedCatalogMatches(
    catalogTools,
    discovered,
    exact,
    new Set(discovered.map((d) => localMcpToolName(d.name, prefix))),
  );
  return discovered.map((d) => {
    const viaNamespace = exact(d) ? undefined : namespaced.get(d.name);
    // Matched through a namespace, the tool keeps the catalog's local name:
    // the snapshot installed before the sign-in, role grants and the listing
    // all use it. It is still called by the name the server gave it.
    const name = viaNamespace?.name ?? localMcpToolName(d.name, prefix);
    const own = exact(d) ?? viaNamespace;
    return {
      name,
      description: d.description,
      parameters: d.parameters,
      endpointMapping: d.endpointMapping,
      ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
      ...(own?.annotations || d.annotations
        ? { annotations: { ...(own?.annotations ?? {}), ...(d.annotations ?? {}) } }
        : {}),
      ...(own?.enabled === false ? { enabled: false } : {}),
    };
  });
}

/** `mcp-tv-get-ohlcv`, `tv.get_ohlcv` and `tv__get_ohlcv` all read `..._get_ohlcv`. */
function toolKey(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('_');
}

/**
 * Catalog tools the server lists under a namespace: a discovered name that
 * is `<namespace><separator><catalog remote name>` (`mcp-tv-get-ohlcv`,
 * `server__get_ohlcv`, `server.get_ohlcv`), compared after folding case and
 * separators. Without this, a gateway's names match nothing in the catalog:
 * the snapshot's tools stay next to the server's as duplicates, and a delete
 * the catalog ships switched off arrives switched on.
 *
 * Only for tools without an exact match, each catalog tool at most once, the
 * longest catalog name wins (`get_alerts_log` before `get_alerts`), and only
 * for a namespace at least two such tools share, so a lone `bulk_delete_alert`
 * is not taken for `delete_alert`. A catalog local name another discovered
 * tool already carries is left alone.
 */
function namespacedCatalogMatches(
  catalogTools: CatalogTool[],
  discovered: DiscoveredMcpTool[],
  exact: (d: DiscoveredMcpTool) => CatalogTool | undefined,
  takenNames: Set<string>,
): Map<string, CatalogTool> {
  const claimed = new Set(discovered.map(exact).filter((t): t is CatalogTool => !!t));
  const candidates = catalogTools
    .filter((t) => !claimed.has(t) && !takenNames.has(t.name) && typeof t.endpointMapping?.method === 'string')
    .map((t) => ({ tool: t, key: toolKey(String(t.endpointMapping.method)) }))
    .filter((c) => c.key !== '')
    .sort((a, b) => b.key.length - a.key.length);

  const found: Array<{ remote: string; namespace: string; tool: CatalogTool }> = [];
  for (const d of discovered) {
    if (exact(d)) continue;
    const key = toolKey(d.name);
    const hit = candidates.find((c) => key.length > c.key.length + 1 && key.endsWith(`_${c.key}`));
    if (hit) found.push({ remote: d.name, namespace: key.slice(0, key.length - hit.key.length - 1), tool: hit.tool });
  }

  const perNamespace = new Map<string, number>();
  for (const f of found) perNamespace.set(f.namespace, (perNamespace.get(f.namespace) ?? 0) + 1);
  const used = new Set<CatalogTool>();
  const matches = new Map<string, CatalogTool>();
  for (const f of found) {
    if ((perNamespace.get(f.namespace) ?? 0) < 2 || used.has(f.tool)) continue;
    used.add(f.tool);
    matches.set(f.remote, f.tool);
  }
  return matches;
}

/**
 * The tools a remote server listed, as this connector should store them:
 * through the catalog policy above when the connector was installed from an
 * MCP adapter, and only renamed with the connector's tool prefix (if any)
 * otherwise. Used by every path that imports tools after install: the
 * authorization callback and "Discover tools".
 */
export function catalogMcpToolsFor(
  connectorConfig: unknown,
  discovered: DiscoveredMcpTool[],
): Array<CatalogTool & { origin?: 'catalog' }> {
  const prefix = mcpToolPrefixOf(connectorConfig);
  const slug = (connectorConfig as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  const adapter = typeof slug === 'string' ? getAdapter(slug) : null;
  if (adapter && adapter.connector.type === 'MCP') {
    return mergeDiscoveredMcpTools(adapter.tools, discovered, prefix).map((t) => ({
      ...t,
      origin: 'catalog' as const,
    }));
  }
  return discovered.map((d) => ({
    name: localMcpToolName(d.name, prefix),
    description: d.description,
    parameters: d.parameters,
    endpointMapping: d.endpointMapping,
    ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
    ...(d.annotations ? { annotations: d.annotations } : {}),
  }));
}

/** One line for the install form: how many tools the server offers, and some names. */
export function describeDiscoveredTools(tools: { name: string }[], shown = 12): string {
  const names = tools.slice(0, shown).map((t) => t.name);
  const more = tools.length > shown ? `, … (${tools.length - shown} more)` : '';
  return `${tools.length} tools on the server: ${names.join(', ')}${more}`;
}
