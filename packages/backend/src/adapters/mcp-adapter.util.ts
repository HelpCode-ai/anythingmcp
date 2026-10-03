import type { AdapterDefinition } from './catalog';
import type { DiscoveredMcpTool } from '../connectors/connectors.service';

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
 * override the server's.
 *
 * Tools the server has and the catalog does not know are installed as the
 * server describes them; catalog tools the server no longer has are left out.
 */
export function mergeDiscoveredMcpTools(
  catalogTools: CatalogTool[],
  discovered: DiscoveredMcpTool[],
): CatalogTool[] {
  const policy = new Map(catalogTools.map((t) => [t.name, t]));
  return discovered.map((d) => {
    const own = policy.get(d.name);
    return {
      name: d.name,
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

/** One line for the install form: how many tools the server offers, and some names. */
export function describeDiscoveredTools(tools: { name: string }[], shown = 12): string {
  const names = tools.slice(0, shown).map((t) => t.name);
  const more = tools.length > shown ? `, … (${tools.length - shown} more)` : '';
  return `${tools.length} tools on the server: ${names.join(', ')}${more}`;
}
