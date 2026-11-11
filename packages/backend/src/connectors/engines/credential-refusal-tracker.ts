/**
 * Repeated 401s on a connector's read tools, turned into a credential status.
 *
 * WHY. A key the provider stops accepting (revoked, its user demoted) keeps
 * being refused: in Oct-Nov 2026 one WooCommerce connector worked for two
 * days, then answered 401 `woocommerce_rest_cannot_view` to up to 145 calls a
 * day for three days, while its caller kept going and nothing on the
 * dashboard said so (`auth_status` was empty on every WooCommerce
 * connector). The OAuth renewal services record refusals they see
 * (connector-auth-status.service.ts); a pasted key had nobody to do it.
 *
 * The rule, kept deliberately narrow so a working connector is never flagged:
 *  - only HTTP 401 (a refused credential; 403 is a permission or a firewall),
 *  - only read tools (a write can be refused for its own reasons),
 *  - only a credential stored on the connector itself (no per-user sign-in,
 *    no credential built from the caller, no OAuth2 or login flow, which
 *    record their own refusals),
 *  - REFUSALS_BEFORE_MARK in a row with no successful call in between.
 * Any successful call clears it, as does changing the connector.
 *
 * Counts live in this process only: a restart starts them over, which at
 * worst delays the status by a few calls.
 */

/** The code of a status recorded here (AuthIssue.code). */
export const CREDENTIAL_REFUSED_CODE = 'credential_refused';

/** Consecutive refused read calls before the connector is marked. */
export const REFUSALS_BEFORE_MARK = 5;

/** Auth types whose credential is a value stored on the connector. */
export const STATIC_CREDENTIAL_AUTH_TYPES = new Set([
  'API_KEY',
  'QUERY_AUTH',
  'BEARER_TOKEN',
  'BASIC_AUTH',
  'OAUTH1',
  'HMAC',
  'WS_SECURITY',
]);

/** Connectors tracked at most; beyond that the counts start over (memory bound). */
const MAX_TRACKED = 20_000;

export class CredentialRefusalTracker {
  private readonly refusals = new Map<string, number>();
  /** Connectors whose status this process has already cleared (or found clear) since their last refusal. */
  private readonly settled = new Set<string>();

  /**
   * One more refused call. The count of refusals in a row when the connector
   * should be marked now, else undefined: at the threshold, and again every
   * 100 refusals after it (a mark lost to a failed write, or cleared by an
   * edit that did not fix the key).
   */
  refused(connectorId: string): number | undefined {
    if (this.refusals.size >= MAX_TRACKED && !this.refusals.has(connectorId)) this.refusals.clear();
    const count = (this.refusals.get(connectorId) ?? 0) + 1;
    this.refusals.set(connectorId, count);
    this.settled.delete(connectorId);
    if (count === REFUSALS_BEFORE_MARK || (count > REFUSALS_BEFORE_MARK && count % 100 === 0)) return count;
    return undefined;
  }

  /**
   * A call that worked. True when a status of ours may be stored and should
   * be cleared: after refusals, and once per connector per process (a mark
   * from before a restart).
   */
  succeeded(connectorId: string): boolean {
    const hadRefusals = this.refusals.delete(connectorId);
    if (!hadRefusals && this.settled.has(connectorId)) return false;
    if (this.settled.size >= MAX_TRACKED) this.settled.clear();
    this.settled.add(connectorId);
    return true;
  }
}

/** The status message: what happened, then the adapter's or the generic advice. */
export function credentialRefusedMessage(count: number, advice: string | undefined): string {
  const text =
    `The API refused this connector's saved credentials on ${count} calls in a row (HTTP 401). ` +
    (advice?.trim() ||
      'They were revoked, expired or changed at the provider: enter valid ones in the connector\'s settings.');
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}
