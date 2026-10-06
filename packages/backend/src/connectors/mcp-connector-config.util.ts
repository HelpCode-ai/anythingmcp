/**
 * Settings of an MCP bridge connector that live in `connector.config`
 * (seeded from a catalog adapter's `connector.config` at install).
 *
 * - `mcpPath`: the endpoint path when the base URL alone cannot say it. A
 *   base URL without a path means `<origin>/mcp` (see resolveMcpEndpointUrl),
 *   so a server listening at the root of its host (Stripe, Apify) sets `"/"`.
 * - `mcpToolPrefix`: prepended to the remote tool names, so two bridged
 *   servers with a `list_issues` each (GitHub and Linear) can sit on the same
 *   MCP server. The call still uses the remote name (endpointMapping.method).
 */
export function mcpPathOf(config: unknown): string | undefined {
  const value = (config as { mcpPath?: unknown } | null | undefined)?.mcpPath;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function mcpToolPrefixOf(config: unknown): string | undefined {
  const value = (config as { mcpToolPrefix?: unknown } | null | undefined)?.mcpToolPrefix;
  return typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value) ? value : undefined;
}

/**
 * The name a remote tool gets here. Without a prefix it is the remote name,
 * unchanged. With one, characters outside `[A-Za-z0-9_]` become `_` (Notion's
 * `notion-search`, Apify's `search-actors`) and the prefix is added unless the
 * name already starts with it (`firecrawl_scrape` stays as it is).
 */
export function localMcpToolName(remoteName: string, prefix?: string): string {
  if (!prefix) return remoteName;
  const normalized = remoteName.replace(/[^A-Za-z0-9_]/g, '_');
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized
    : `${prefix}${normalized}`;
}
