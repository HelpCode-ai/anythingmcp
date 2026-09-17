/**
 * Read-only MCP resource registration helpers.
 *
 * Resource definitions are assembled by the endpoint after tenant and server
 * membership checks have completed.  Fetch configs intentionally support only
 * values already stored in the database; accepting arbitrary URLs here would
 * turn resources into an SSRF primitive.
 */

import { McpServer } from '@modelcontextprotocol/server';

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string | null;
  mimeType?: string | null;
  fetchConfig: unknown;
}

export interface RegisteredResource extends ResourceDefinition {
  read: () => Promise<{ text: string; mimeType: string }>;
}

/** Convert a persisted fetch config into bounded, local-only content. */
export function contentFromFetchConfig(fetchConfig: unknown): {
  text: string;
  mimeType?: string;
} {
  if (fetchConfig && typeof fetchConfig === 'object') {
    const config = fetchConfig as Record<string, unknown>;
    if (typeof config.text === 'string') {
      return { text: config.text, mimeType: typeof config.mimeType === 'string' ? config.mimeType : undefined };
    }
    if (typeof config.content === 'string') {
      return { text: config.content, mimeType: typeof config.mimeType === 'string' ? config.mimeType : undefined };
    }
  }
  return {
    text: '[resource content is not available: only local static content is supported]',
  };
}

export function makeResource(
  definition: ResourceDefinition,
  staticContent?: { text: string; mimeType?: string },
): RegisteredResource {
  const fallback = staticContent ?? contentFromFetchConfig(definition.fetchConfig);
  return {
    ...definition,
    read: async () => ({
      text: fallback.text,
      mimeType: fallback.mimeType ?? definition.mimeType ?? 'text/plain',
    }),
  };
}

/** Register resources on one per-request MCP server, deduplicating URIs. */
export function registerResources(
  server: McpServer,
  resources: RegisteredResource[],
  warn: (message: string) => void = () => undefined,
): number {
  const seen = new Set<string>();
  let registered = 0;
  for (const resource of resources) {
    if (!resource.uri || seen.has(resource.uri)) {
      if (resource.uri) warn(`Duplicate MCP resource URI "${resource.uri}" — skipping the extra copy`);
      continue;
    }
    seen.add(resource.uri);
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.name,
        description: resource.description ?? undefined,
        mimeType: resource.mimeType ?? undefined,
      },
      async (requestedUri) => {
        const content = await resource.read();
        return {
          contents: [
            {
              uri: requestedUri?.href ?? resource.uri,
              mimeType: content.mimeType,
              text: content.text,
            },
          ],
        };
      },
    );
    registered++;
  }
  return registered;
}
