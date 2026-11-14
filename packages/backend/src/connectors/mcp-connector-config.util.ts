import { interpolateDeep } from '../common/env-interpolation.util';

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
 * - `mcpFixedArguments`: an object merged into the arguments of every
 *   `tools/call`, for a value the server wants on each call and the model has
 *   no business choosing (the agent profile URL of a UCP shop). The same
 *   paths are dropped from the tool schemas the model sees. Absent, nothing
 *   changes.
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
 * unchanged. With one, runs of characters outside `[A-Za-z0-9_]` become a
 * single `_` (Notion's `notion-search`, Apify's `apify--rag-web-browser`) and
 * the prefix is added unless the name already starts with it
 * (`firecrawl_scrape` stays as it is).
 */
export function localMcpToolName(remoteName: string, prefix?: string): string {
  if (!prefix) return remoteName;
  const normalized = remoteName.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_{2,}/g, '_');
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized
    : `${prefix}${normalized}`;
}

/**
 * The connector variables a remote MCP tool may get as arguments: only the
 * names that are top-level properties of its input schema. Every variable,
 * credentials included, used to be added to the arguments of every call (the
 * REST engines need all of them for `$name` in paths and bodies), so a bridge
 * sent its own API key or token to the remote server as a tool argument,
 * where it could end up in the vendor's logs or be refused as unknown.
 */
export function envVarsForMcpTool(
  envVars: Record<string, string>,
  parameters: unknown,
): Record<string, string> {
  const props = (parameters as { properties?: unknown } | null | undefined)?.properties;
  if (!props || typeof props !== 'object') return {};
  return Object.fromEntries(
    Object.entries(envVars).filter(([name]) => Object.prototype.hasOwnProperty.call(props, name)),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** Never copied from a connector setting into call arguments. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The connector's `mcpFixedArguments`, or undefined when it has none (absent,
 * empty, or not an object). `{{VAR}}` placeholders are still in it: the
 * caller resolves them with the connector's variables before a call.
 */
export function mcpFixedArgumentsOf(config: unknown): Record<string, unknown> | undefined {
  const value = (config as { mcpFixedArguments?: unknown } | null | undefined)?.mcpFixedArguments;
  return isPlainObject(value) && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * The fixed arguments as a call sends them: `{{VAR}}` resolved with the
 * connector's variables, like the rest of the connector's settings.
 */
export function resolveMcpFixedArguments(
  config: unknown,
  envVars: Record<string, string> | null | undefined,
): Record<string, unknown> | undefined {
  const fixed = mcpFixedArgumentsOf(config);
  return fixed ? interpolateDeep(fixed, envVars ?? {}) : undefined;
}

/**
 * The arguments of a bridged call with the connector's fixed arguments merged
 * in. Objects merge key by key, so `{ meta: { 'ucp-agent': { profile } } }`
 * keeps an `idempotency-key` the caller put into `meta`; anything else
 * (strings, numbers, arrays) replaces what the caller sent at that path: the
 * fixed value always wins. Returns the caller's object itself when there is
 * nothing to merge, and never changes either input.
 */
export function withMcpFixedArguments(
  args: Record<string, unknown>,
  fixed: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fixed) return args;
  const out: Record<string, unknown> = { ...(isPlainObject(args) ? args : {}) };
  for (const [key, value] of Object.entries(fixed)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (isPlainObject(value)) {
      const sent = hasOwn(out, key) ? out[key] : undefined;
      out[key] = withMcpFixedArguments(isPlainObject(sent) ? sent : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A copy of a tool's JSON Schema without the paths the connector fills in on
 * every call, so the model is not asked for them. A fixed value drops its
 * property, also from `required`. A fixed object is followed into the
 * property's own `properties`; when none are left the property goes as a
 * whole, otherwise it stays with the rest (`meta` of a UCP `complete_checkout`
 * keeps `idempotency-key` and loses `ucp-agent`). A property that is fixed
 * as an object and declares no properties of its own is dropped; one
 * described by `$ref`, `anyOf`, `oneOf` or `allOf` is left as it is, because
 * what remains of it cannot be told from here.
 *
 * Only the keys of `fixed` matter, so it may still hold `{{VAR}}` values. The
 * schema is returned as is when there is nothing to drop.
 */
export function withoutMcpFixedArguments(
  parameters: Record<string, unknown>,
  fixed: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fixed || !isPlainObject(parameters)) return parameters;
  const props = isPlainObject(parameters.properties) ? parameters.properties : undefined;
  const required = Array.isArray(parameters.required) ? (parameters.required as unknown[]) : undefined;

  const dropped = new Set<string>();
  const trimmed = new Map<string, unknown>();
  for (const [key, value] of Object.entries(fixed)) {
    const declared = props && hasOwn(props, key) ? props[key] : undefined;
    if (declared === undefined) {
      // Not described, but possibly demanded: the bridge supplies it.
      if (required?.includes(key)) dropped.add(key);
      continue;
    }
    if (!isPlainObject(value)) {
      dropped.add(key);
      continue;
    }
    if (!isPlainObject(declared) || ['$ref', 'anyOf', 'oneOf', 'allOf'].some((k) => hasOwn(declared, k))) {
      continue;
    }
    if (!isPlainObject(declared.properties)) {
      dropped.add(key);
      continue;
    }
    const inner = withoutMcpFixedArguments(declared, value);
    if (Object.keys(inner.properties as Record<string, unknown>).length === 0) dropped.add(key);
    else if (inner !== declared) trimmed.set(key, inner);
  }
  if (dropped.size === 0 && trimmed.size === 0) return parameters;

  const out: Record<string, unknown> = { ...parameters };
  if (props) {
    out.properties = Object.fromEntries(
      Object.entries(props)
        .filter(([key]) => !dropped.has(key))
        .map(([key, schema]) => [key, trimmed.has(key) ? trimmed.get(key) : schema]),
    );
  }
  if (required) out.required = required.filter((name) => !dropped.has(name as string));
  return out;
}
