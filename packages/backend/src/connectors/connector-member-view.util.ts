import type { VisibilityScope } from '../settings/member-visibility.service';

/**
 * The reduced view of a connector for a member of a workspace with restricted
 * member visibility (settings/member-visibility.service.ts) who can see the
 * connector but does not own it: that it exists, whether it works, whether
 * they sign in to it themselves, and the tools they may use. Nothing about
 * where it connects or how.
 *
 * Both lists are allowlists: a field added to the connector or tool model
 * later is not in this view until it is named here. Left out on purpose:
 * `baseUrl` (host, port, database and user name), `specUrl`, `config`,
 * `envVars` / `maskedEnvVars`, `headers` / `maskedHeaders`, `instructions`,
 * `authType`, `missingVariables` (variable names), `authStatusMessage` (the
 * provider's own words), the webhook fields, the owner's id, and on a tool
 * `parameters`, `endpointMapping` (the SQL of a database tool),
 * `responseMapping`, `outputSchema` and `annotations`.
 */
export const MEMBER_CONNECTOR_FIELDS = [
  'id',
  'name',
  'type',
  // The adapter's logo name, for the list card.
  'icon',
  'isActive',
  // USER: the member signs in with their own account ("Connect my account").
  'credentialScope',
  // The page where they do it (a link under /auth/connect; names no host or variable).
  'connectUrl',
  // The badges next to "Active": ready / needs_input / needs_authorization,
  // and the credential health with its machine-readable reason.
  'setupStatus',
  'authStatus',
  'authStatusCode',
] as const;

export const MEMBER_TOOL_FIELDS = ['id', 'name', 'description', 'isEnabled'] as const;

export type MemberTool = Partial<Record<(typeof MEMBER_TOOL_FIELDS)[number], unknown>>;
export type MemberConnector = Partial<Record<(typeof MEMBER_CONNECTOR_FIELDS)[number], unknown>> & {
  /** Always true: tells a client this is the reduced view, not a connector with empty settings. */
  memberView: true;
  tools: MemberTool[];
};

function pick<K extends string>(source: object, fields: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = (source as Record<string, unknown>)[field];
    }
  }
  return out;
}

/**
 * True when the caller gets the reduced view of this connector: their
 * visibility is restricted and they do not own it. Admins, owners and every
 * caller in an open workspace keep the full view.
 */
export function seesMemberView(scope: VisibilityScope, connector: { userId: string }): boolean {
  return scope.restricted && connector.userId !== scope.userId;
}

/** A tool as a restricted member who does not own its connector may see it. */
export function toMemberTool(tool: object): MemberTool {
  return pick(tool, MEMBER_TOOL_FIELDS);
}

/**
 * A connector as a restricted member who does not own it may see it. Pass the
 * connector with its tools already narrowed to the ones the member may use
 * (`visibleTools`): this function reduces fields, it does not decide which
 * tools are visible.
 */
export function toMemberConnector(connector: object): MemberConnector {
  const tools = (connector as { tools?: unknown }).tools;
  return {
    ...pick(connector, MEMBER_CONNECTOR_FIELDS),
    memberView: true,
    tools: Array.isArray(tools) ? tools.map((tool) => toMemberTool(tool as object)) : [],
  };
}
