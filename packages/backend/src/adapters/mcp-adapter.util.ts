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
  return discovered.map((d) => {
    const name = localMcpToolName(d.name, prefix);
    const own = byName.get(name) ?? byMethod.get(d.name);
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
