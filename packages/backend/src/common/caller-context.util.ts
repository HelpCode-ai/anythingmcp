/**
 * Caller-context variables — `{{amcp.*}}`.
 *
 * Connectors often sit in front of *service*-based APIs while users authenticate
 * to AnythingMCP individually (OAuth, per-user MCP API keys). Without this, the
 * target system only ever sees the service identity and cannot record who
 * actually asked. These variables let an operator forward the calling identity
 * explicitly, e.g. a header `X-Requested-By: {{amcp.user_email}}`.
 *
 * Design constraints:
 *  - RESERVED and non-overridable: the values are resolved server-side from the
 *    authenticated request, and are merged *after* connector env vars so a
 *    workspace variable (or a tool argument) can never spoof an identity.
 *  - OPT-IN: nothing is forwarded unless the operator writes the variable into a
 *    header/query/body. Identity is personal data, so silently attaching it to
 *    every outbound request would be wrong (and a GDPR problem).
 *  - ALWAYS DEFINED: an unavailable value resolves to an empty string rather
 *    than leaking a literal `{{amcp.…}}` to the target. Identity is absent for
 *    instance-wide static credentials and in anonymous mode; it is present for
 *    OAuth and per-user API keys.
 */

/** Prefix marking the reserved, server-resolved namespace. */
export const CALLER_CONTEXT_PREFIX = 'amcp.';

/** Identity/context of the MCP caller, as resolved by the auth guard. */
export interface CallerContext {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  mcpServerId?: string;
  mcpServerName?: string;
  authMethod?: string;
  apiKeyName?: string;
}

/** Every supported variable, with the doc string surfaced in the UI/API. */
export const CALLER_CONTEXT_VARIABLES: Record<string, string> = {
  'amcp.user_email':
    'E-mail of the calling user. Empty for instance-wide static credentials and anonymous access.',
  'amcp.user_id': 'Internal id of the calling user.',
  'amcp.org_id': 'Id of the workspace (organization) the call belongs to.',
  'amcp.server_id': 'Id of the MCP server that exposed the tool.',
  'amcp.server_name': 'Name of the MCP server that exposed the tool.',
  'amcp.auth_method':
    'How the caller authenticated: jwt, mcp_api_key, static_api_key, static_bearer or none.',
  'amcp.api_key_name': 'Name of the MCP API key used, when the caller used one.',
};

/**
 * Build the reserved variable map. Every known key is always present so a
 * missing identity yields an empty value instead of an unresolved placeholder.
 */
export function buildCallerContextVars(
  context?: CallerContext,
): Record<string, string> {
  return {
    'amcp.user_email': context?.userEmail ?? '',
    'amcp.user_id': context?.userId ?? '',
    'amcp.org_id': context?.organizationId ?? '',
    'amcp.server_id': context?.mcpServerId ?? '',
    'amcp.server_name': context?.mcpServerName ?? '',
    'amcp.auth_method': context?.authMethod ?? '',
    'amcp.api_key_name': context?.apiKeyName ?? '',
  };
}

/** True when the string references at least one reserved variable. */
export function usesCallerContext(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    new RegExp(`\\{\\{\\s*${CALLER_CONTEXT_PREFIX.replace('.', '\\.')}`).test(value)
  );
}

/**
 * Reserved variables referenced by a value (recursively) that are not
 * recognised — i.e. typos. Callers use this to reject a bad configuration at
 * save time, since at runtime they resolve to empty.
 */
export function findUnknownCallerContextVars(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\{\{([^}]+)\}\}/g)) {
        const key = match[1].trim();
        if (
          key.startsWith(CALLER_CONTEXT_PREFIX) &&
          !(key in CALLER_CONTEXT_VARIABLES)
        ) {
          found.add(key);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return [...found];
}
