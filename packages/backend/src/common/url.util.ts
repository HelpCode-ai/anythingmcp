import { BadRequestException } from '@nestjs/common';

// Connector types whose baseUrl is an http(s) endpoint. DATABASE connectors
// carry their own scheme (mysql://, mongodb://, sqlite:, …) and must not be
// rewritten to https.
const HTTP_CONNECTOR_TYPES = new Set(['REST', 'GRAPHQL', 'SOAP', 'MCP']);

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Normalize and validate a user-entered connector base URL.
 *
 * - Trims surrounding whitespace.
 * - For HTTP-style connectors (REST/GraphQL/SOAP/MCP) prepends `https://` when
 *   no scheme is present, so `api.example.com` is stored as
 *   `https://api.example.com` instead of silently failing at request time with
 *   a cryptic DNS error (production showed hosts mangled to e.g. `api.https`).
 * - Rejects anything that cannot be parsed as a URL, or whose scheme is not
 *   http/https, with an actionable message — so a malformed base URL is caught
 *   at save time instead of on every tool call.
 *
 * DATABASE (and any non-HTTP) connectors are returned trimmed but otherwise
 * untouched, since their scheme is meaningful and SSRF-checked elsewhere.
 */
export function normalizeConnectorBaseUrl(
  baseUrl: string,
  type?: string,
): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    throw new BadRequestException('Base URL is required.');
  }

  // Non-HTTP connectors (DATABASE, etc.) keep their own scheme verbatim.
  if (type && !HTTP_CONNECTOR_TYPES.has(type)) {
    return trimmed;
  }

  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new BadRequestException(
      `"${baseUrl}" is not a valid URL. Use a full address like ` +
        `https://api.example.com.`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(
      `Base URL must start with http:// or https:// (got "${parsed.protocol}" ` +
        `from "${baseUrl}").`,
    );
  }

  return withScheme;
}

/**
 * The path every discovered MCP tool has been stamped with since the MCP
 * bridge shipped. It is a *default*, not a user choice: nothing in the UI ever
 * asked for it, so it must not be allowed to override a real path.
 */
export const DEFAULT_MCP_PATH = '/mcp';

/**
 * Resolve the outbound URL of a remote MCP endpoint.
 *
 * The bridge used to build this with `new URL('/mcp', baseUrl)`, whose
 * root-absolute path silently resolves against the *origin* and throws away
 * any path the base URL carried. That made every MCP server not hosted at
 * `<origin>/mcp` unreachable — Snowflake's managed servers
 * (`/api/v2/databases/…/mcp-servers/<name>`), Zoho's
 * (`/mcp/<token>/message`), and even AnythingMCP's own per-tenant
 * `/mcp/<serverId>` endpoints (issue #501).
 *
 * Resolution order:
 *  1. An override that is a full `http(s)://` URL wins verbatim — the same
 *     per-tool escape hatch RestEngine offers for vendors spread over several
 *     hosts.
 *  2. A root-absolute override (`/sse`) resolves against the origin, exactly
 *     as before, so explicitly-configured paths keep their meaning.
 *  3. A relative override (`sub/mcp`) is joined onto the base URL's path.
 *  4. No override — or the historical `/mcp` default, which is
 *     indistinguishable from "unset" — means the base URL *is* the endpoint
 *     when it carries a path, and `<origin>/mcp` when it does not.
 */
export function resolveMcpEndpointUrl(
  baseUrl: string,
  pathOverride?: string,
): URL {
  let base: URL;
  try {
    base = new URL((baseUrl ?? '').trim());
  } catch {
    throw new BadRequestException(
      `"${baseUrl}" is not a valid MCP server URL. Use a full address like ` +
        `https://mcp.example.com/mcp.`,
    );
  }

  const override = (pathOverride ?? '').trim();
  // Trailing slashes carry no meaning here and would otherwise produce a
  // double slash at the seam ("…/base//sub").
  const basePath = base.pathname.replace(/\/+$/, '');

  if (override && override !== DEFAULT_MCP_PATH) {
    if (/^https?:\/\//i.test(override)) return new URL(override);
    return withPath(
      base,
      override.startsWith('/')
        ? override
        : `${basePath}/${override.replace(/^\/+/, '')}`,
      '',
    );
  }

  // Preserve the query string: some hosted gateways carry a key there.
  if (basePath) return withPath(base, basePath, base.search);

  return withPath(base, DEFAULT_MCP_PATH, '');
}

/**
 * Rebuild a URL with a different path, keeping everything else the base URL
 * carried — port, and in particular any `user:pass@` credentials, which
 * `new URL(path, origin)` would silently drop.
 */
function withPath(base: URL, pathname: string, search: string): URL {
  const url = new URL(base.toString());
  url.pathname = pathname;
  url.search = search;
  url.hash = '';
  return url;
}
