/**
 * Cloud-only: route the public db-rest base URL to our internal self-hosted
 * instance. The shipped Deutsche Bahn connector stores the public base URL
 * (`v6.db.transport.rest`) so self-hosters use it as-is; in cloud we swap the
 * host to the internal db-rest (`DB_REST_INTERNAL_URL`) at request time. Pure
 * host swap — same db-rest schema both sides, so paths/params/responses are
 * unchanged. Returns the URL untouched on self-host (env unset / not cloud).
 *
 * Used by both the tool-execution path (DynamicMcpTools) and the connector
 * "Test connection" / health-check path so they exercise the SAME endpoint.
 */
const PUBLIC_DB_REST = 'https://v6.db.transport.rest';

export function resolveInternalDbRestUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const internal = env.DB_REST_INTERNAL_URL;
  const isCloud = (env.DEPLOYMENT_MODE || '') === 'cloud';
  if (internal && isCloud && baseUrl.startsWith(PUBLIC_DB_REST)) {
    return internal.replace(/\/$/, '') + baseUrl.slice(PUBLIC_DB_REST.length);
  }
  return baseUrl;
}
