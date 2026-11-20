/**
 * Recognises the documentation placeholder pasted as an MCP server id.
 *
 * Setup guides show the per-server address as `<base>/mcp/YOUR_SERVER_ID`,
 * and assistants sometimes hand that address (or `YOUR_SERVER_ID, then click
 * Add.`) to a user, who pastes it into their MCP client as is. The id never
 * exists, so the client used to get a bare "MCP server not found". This only
 * picks a clearer message for that 404: it is consulted after the server
 * lookup failed, so it can never shadow a real server, and it grants nothing.
 */

/** `YOUR_SERVER_ID`, `your-server-id`, `YourServerId` ... followed by anything. */
const YOUR_SERVER_ID = /^your[\s_-]?server[\s_-]?id/i;
/** `<server-id>`, `{serverId}`, `[server_id]`, `:serverId`. */
const BRACKETED_SERVER_ID = /^(?:<\s*server[\s_-]?id\s*>|\{\s*server[\s_-]?id\s*\}|\[\s*server[\s_-]?id\s*\]|:server[\s_-]?id)$/i;

export function isPlaceholderServerId(serverId: unknown): boolean {
  if (typeof serverId !== 'string' || !serverId) return false;
  let value = serverId;
  // Express already decodes route params; decode once more for a value that
  // arrives double-encoded (`YOUR_SERVER_ID%2C%20then...`). A malformed
  // escape keeps the raw value.
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  value = value.trim();
  return YOUR_SERVER_ID.test(value) || BRACKETED_SERVER_ID.test(value);
}

/** The message of the 404 for a placeholder id; `baseUrl` has no trailing slash. */
export function placeholderServerIdMessage(baseUrl: string): string {
  return (
    'MCP server not found: this address contains the placeholder from the setup guide, ' +
    'not a real server id. Replace YOUR_SERVER_ID with the id of your server ' +
    '(AnythingMCP dashboard, MCP Servers page, where the full address can be copied), ' +
    `or connect with sign-in at ${baseUrl}/mcp.`
  );
}
