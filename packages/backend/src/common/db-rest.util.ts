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

/**
 * Cloud-only: override the db-rest request profile from `dbnav` to `dbweb`.
 *
 * The shipped Deutsche Bahn connector pins `profile=dbnav` — the db-vendo-client
 * profile that works from a normal (residential) self-host IP, so self-hosters
 * keep using it verbatim. In AnythingMCP Cloud the internal db-rest egresses
 * through the Zyte web-unblocker to defeat Deutsche Bahn's Akamai block of
 * datacenter IPs; over that path DB's `dbnav` mobile endpoints reject the request
 * (`Method Not Allowed` / `OPS_BLOCKED`) while the `dbweb` (bahn.de web API)
 * endpoints work. So in cloud only — and only for a `dbnav` request actually
 * bound for the internal db-rest — swap the profile to `dbweb`.
 *
 * Returns the query params untouched on self-host (env unset / not cloud), for
 * non-db-rest targets, and for any non-`dbnav` profile, so it is safe to call
 * unconditionally from the generic REST engine.
 */
export const CLOUD_DB_REST_PROFILE = 'dbweb';

export function resolveDbRestProfile(
  requestUrl: string,
  queryParams: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  const internal = env.DB_REST_INTERNAL_URL;
  const isCloud = (env.DEPLOYMENT_MODE || '') === 'cloud';
  if (!queryParams || !isCloud || !internal) return queryParams;
  if (queryParams.profile !== 'dbnav') return queryParams;
  if (!requestUrl.startsWith(internal.replace(/\/$/, ''))) return queryParams;
  return { ...queryParams, profile: CLOUD_DB_REST_PROFILE };
}
