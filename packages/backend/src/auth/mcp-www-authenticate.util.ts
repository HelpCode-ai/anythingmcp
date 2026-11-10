/**
 * The `WWW-Authenticate` value of a 401 on an MCP resource.
 *
 * The MCP spec requires `resource_metadata`, pointing at the protected-resource
 * metadata document (RFC 9728). That URL appends the resource path (`/mcp` or
 * `/mcp/<serverId>`) to the well-known prefix, so each resource advertises its
 * own metadata; any other path falls back to the root document.
 *
 * RFC 6750 §3.1: `error="invalid_token"` tells the client its token can no
 * longer be used and it must authorize again, rather than retry. A request
 * that carried no token at all gets no error code: the RFC says so, and a
 * client's first unauthenticated probe should not be told its token is bad.
 */
export function mcpWwwAuthenticate(
  req: { headers: Record<string, string | string[] | undefined>; secure?: boolean },
  resourcePath: string,
  fallbackBaseUrl: string,
): string {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const proto = header('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  const host = header('x-forwarded-host') || header('host');
  const baseUrl = host ? `${proto}://${host}` : fallbackBaseUrl;
  const resourceMetadataUrl = resourcePath.startsWith('/mcp')
    ? `${baseUrl}/.well-known/oauth-protected-resource${resourcePath}`
    : `${baseUrl}/.well-known/oauth-protected-resource`;
  const presentedToken = header('authorization')?.toLowerCase().startsWith('bearer ');
  const errorAttr = presentedToken ? 'error="invalid_token", ' : '';
  return `Bearer realm="AnythingMCP MCP Server", ${errorAttr}resource_metadata="${resourceMetadataUrl}"`;
}
