/** Where `npx @modelcontextprotocol/inspector` serves its web UI (v2 default port). */
export const INSPECTOR_URL = 'http://localhost:6274/';

/**
 * Command that starts the MCP Inspector already pointed at this server.
 *
 * Inspector v2 ignores `?serverUrl=` deep links unless they also carry the
 * per-launch session token (`autoConnect`), which is secret, so we pre-fill the
 * connection through CLI flags instead. Only the server URL goes in here:
 * never API keys or tokens.
 */
export function inspectorCommand(endpointUrl: string): string {
  return `npx @modelcontextprotocol/inspector --server-url "${endpointUrl}" --transport http`;
}
