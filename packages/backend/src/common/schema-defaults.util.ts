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

/**
 * Fill a parameter the caller left out from a connector variable, as a
 * tool's `endpointMapping.envDefaults` asks: `{ "chat_id":
 * "TELEGRAM_DEFAULT_CHAT_ID" }` sends the workspace's default chat when the
 * call names none.
 *
 * WHY. Some values are the same on nearly every call of one workspace (the
 * chat a bot writes to) and the model cannot know them. A variable named
 * like the parameter already fills it (injectEnvVars), but that forces a
 * variable called `chat_id`; this names the variable instead.
 *
 * Only `undefined`, `null` and `''` are filled, and only from a variable
 * that holds a non-empty string. The mapping is the catalog's, never the
 * caller's; a variable that is not set leaves the call as it was.
 */
export function applyEnvDefaults(
  endpointMapping: unknown,
  params: Record<string, unknown>,
  envVars: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const defaults = (endpointMapping as { envDefaults?: unknown } | null | undefined)?.envDefaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || !envVars) return params;

  const result = { ...params };
  for (const [param, variable] of Object.entries(defaults as Record<string, unknown>)) {
    if (typeof variable !== 'string') continue;
    const given = result[param];
    if (given !== undefined && given !== null && given !== '') continue;
    const value = Object.prototype.hasOwnProperty.call(envVars, variable) ? envVars[variable] : undefined;
    if (typeof value === 'string' && value.trim() !== '') result[param] = value.trim();
  }
  return result;
}
