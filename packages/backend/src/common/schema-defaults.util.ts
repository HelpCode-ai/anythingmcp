/**
 * Fill in the JSON-Schema `default` of every top-level parameter the caller
 * left out.
 *
 * The MCP path does this before a tool runs, and adapters rely on it: a
 * query-language string such as `campaign.name LIKE '${campaign_name}'` is
 * dropped whole by the REST engine when a placeholder has no value, so an
 * optional filter carries a default that matches everything. Every other
 * path that executes a tool (the in-app Run Test, the install probe) must do
 * the same, or it sends a different request than a real call would.
 *
 * Only `undefined` is filled: an explicit empty string or `null` from the
 * caller is theirs to send.
 */
export function applySchemaDefaults(
  schema: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (schema as { properties?: unknown } | null | undefined)
    ?.properties;
  if (!properties || typeof properties !== 'object') return params;

  const result = { ...params };
  for (const [key, prop] of Object.entries(properties)) {
    const fallback = (prop as { default?: unknown } | null)?.default;
    if (result[key] === undefined && fallback !== undefined) {
      result[key] = fallback;
    }
  }
  return result;
}
