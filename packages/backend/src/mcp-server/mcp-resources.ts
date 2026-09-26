/**
 * Read-only MCP resources served on a per-server endpoint (`/mcp/:serverId`).
 *
 * Everything here is pure: the controller loads the inputs (already narrowed
 * to the caller's connectors) and registers what `planServerResources`
 * returns. See docs/mcp-resources.md for the URI scheme and the rules.
 */

/** Scheme of every resource AnythingMCP itself publishes. Reserved: a stored
 *  resource row may not use it, so it can never shadow one of ours. */
export const AMCP_RESOURCE_SCHEME = 'anythingmcp:';

export function serverInstructionsUri(serverId: string): string {
  return `anythingmcp://server/${serverId}/instructions`;
}

export function connectorInstructionsUri(serverId: string, connectorId: string): string {
  return `anythingmcp://server/${serverId}/connector/${connectorId}/instructions`;
}

/**
 * Served instead of a stored resource's body whenever that body is not an
 * explicit string. A stored resource may describe a remote URL or carry an
 * arbitrary `data` object (which can hold credentials); neither is fetched nor
 * serialized.
 */
export const RESOURCE_PLACEHOLDER_TEXT =
  'This resource has no static text content. AnythingMCP serves only explicit text ' +
  'for stored resources; it does not fetch remote URLs or expose stored configuration.';

/**
 * The connectors a caller may see on a server: the connectors that own at
 * least one tool surviving BOTH filters of the tool path, i.e. assigned to the
 * server (`serverTools` is already narrowed to the assignment) AND allowed by
 * the caller's role.
 *
 * `allowedToolIds === null` means the role does not narrow anything (ADMIN, no
 * MCP role, instance credential); the caller then keeps every assigned
 * connector, including one with no registered tool, which is exactly what
 * initialize served before role scoping existed.
 *
 * Every connector-scoped surface on the endpoint (initialize instructions,
 * resources, the knowledge graph) is derived from this one function, so none
 * of them can drift from the tool list.
 */
export function callerConnectorIds(
  serverTools: ReadonlyArray<{ id: string; connectorId: string }>,
  allowedToolIds: string[] | null,
  assignedConnectorIds: string[],
): string[] {
  if (allowedToolIds === null) return assignedConnectorIds;
  const allowed = new Set(allowedToolIds);
  return [
    ...new Set(serverTools.filter((t) => allowed.has(t.id)).map((t) => t.connectorId)),
  ];
}

/**
 * The body of a stored resource, or null when it has none we may serve.
 * Only an explicit string `text` (or `content`) counts. A `url`, a `data`
 * object, or anything else yields null and the caller serves the placeholder.
 */
export function staticResourceText(fetchConfig: unknown): string | null {
  if (!fetchConfig || typeof fetchConfig !== 'object' || Array.isArray(fetchConfig)) {
    return null;
  }
  const { text, content } = fetchConfig as Record<string, unknown>;
  if (typeof text === 'string') return text;
  if (typeof content === 'string') return content;
  return null;
}

/** `type/subtype` only; anything odd is served as plain text. */
function safeMimeType(value: unknown): string {
  return typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value
    : 'text/plain';
}

/**
 * The URI as the SDK will look it up. `resources/read` resolves
 * `new URL(uri).toString()`, so a resource registered under any other spelling
 * would be listed and then unreadable. Null when the string is not a URI.
 */
function normalizeUri(uri: string): string | null {
  try {
    return new URL(uri).toString();
  } catch {
    return null;
  }
}

export interface PlannedResource {
  uri: string;
  name: string;
  title: string;
  description?: string;
  mimeType: string;
  text: string;
  /** Connector the resource belongs to; undefined for server-level ones. */
  connectorId?: string;
}

export interface ResourcePlanInput {
  serverId: string;
  serverName: string;
  /** Composed instructions exactly as served on initialize. */
  instructions: string | undefined;
  /** Visible connectors that have instructions of their own. */
  connectors: ReadonlyArray<{ id: string; name: string; instructions: string }>;
  /** Stored resource rows of visible connectors. */
  resources: ReadonlyArray<{
    connectorId: string;
    uri: string;
    name: string;
    description: string | null;
    mimeType: string;
    fetchConfig: unknown;
  }>;
}

export interface ResourcePlan {
  resources: PlannedResource[];
  /** URIs claimed by more than one visible resource. None of them is served. */
  ambiguous: string[];
  /** Stored rows skipped because their URI is invalid or uses our scheme. */
  rejected: string[];
}

/**
 * Builds the resource set of one caller from inputs that are already scoped to
 * the connectors that caller may see. Nothing here widens that scope; it can
 * only drop entries.
 *
 * A URI claimed twice is withheld entirely rather than resolved to either
 * claimant: picking one silently would serve content the other connector's
 * owner never wrote under a name they chose.
 */
export function planServerResources(input: ResourcePlanInput): ResourcePlan {
  const candidates: PlannedResource[] = [];
  const rejected: string[] = [];

  if (input.instructions) {
    candidates.push({
      uri: serverInstructionsUri(input.serverId),
      name: 'server-instructions',
      title: `${input.serverName}: instructions`,
      description:
        "The instructions this MCP server gives the model on connect: the server's own " +
        'guidance plus that of each connector you can use here.',
      mimeType: 'text/markdown',
      text: input.instructions,
    });
  }

  for (const c of input.connectors) {
    if (!c.instructions) continue;
    candidates.push({
      uri: connectorInstructionsUri(input.serverId, c.id),
      name: `connector-instructions:${c.id}`,
      title: `${c.name}: setup and usage`,
      description: `Setup and usage instructions of the ${c.name} connector.`,
      mimeType: 'text/markdown',
      text: c.instructions,
      connectorId: c.id,
    });
  }

  for (const row of input.resources) {
    const uri = normalizeUri(row.uri);
    if (!uri || new URL(uri).protocol === AMCP_RESOURCE_SCHEME) {
      rejected.push(row.uri);
      continue;
    }
    const text = staticResourceText(row.fetchConfig);
    candidates.push({
      uri,
      name: row.name,
      title: row.name,
      ...(row.description ? { description: row.description } : {}),
      mimeType: text === null ? 'text/plain' : safeMimeType(row.mimeType),
      text: text ?? RESOURCE_PLACEHOLDER_TEXT,
      connectorId: row.connectorId,
    });
  }

  const count = new Map<string, number>();
  for (const r of candidates) count.set(r.uri, (count.get(r.uri) ?? 0) + 1);
  const ambiguous = [...count].filter(([, n]) => n > 1).map(([uri]) => uri);
  const withheld = new Set(ambiguous);

  return {
    resources: candidates.filter((r) => !withheld.has(r.uri)),
    ambiguous,
    rejected,
  };
}
