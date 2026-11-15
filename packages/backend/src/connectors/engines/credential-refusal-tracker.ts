/**
 * Repeated refusals of a connector's stored credential, turned into a
 * credential status (and one email to the workspace owner).
 *
 * WHY. A key the provider stops accepting (revoked, expired, its user
 * demoted) keeps being refused: in Oct-Nov 2026 one WooCommerce connector
 * worked for two days, then answered 401 `woocommerce_rest_cannot_view` to up
 * to 145 calls a day for three days, while its caller kept going and nothing
 * on the dashboard said so. The OAuth renewal services record refusals they
 * see (connector-auth-status.service.ts); a pasted key had nobody to do it.
 *
 * The first version counted five refusals in a row in this process and sent
 * no email. In the week of 8-15 Nov 2026 about 100 connectors had refused
 * credentials (Odoo, Telegram, Shopify and others) and not one was marked:
 * people stop after two or three failed calls, every deploy started the
 * counts over, and a Telegram token (in the URL) or an Odoo JSON-RPC key (in
 * the body, refused inside a 200) was not looked at at all.
 *
 * The rule, kept narrow so a working connector is never flagged:
 *  - a refused credential: HTTP 401, or an answer the error hints know as
 *    "this key is wrong" (Telegram's 404 for a bad token, Odoo's Access
 *    Denied); never 403 (a permission or a firewall) or a missing scope,
 *  - only read tools (a write can be refused for its own reasons),
 *  - only a credential stored on the connector itself (no per-user sign-in,
 *    no credential built from the caller, no OAuth2 or login flow, which
 *    record their own refusals),
 *  - REFUSALS_BEFORE_MARK in a row with no successful call in between.
 * Any successful call clears it, as does changing the connector.
 *
 * Counts are kept in Redis too (dynamic-mcp-tools.ts), so a restart does not
 * start them over; without Redis the counts of this process are used.
 */

/** The code of a status recorded here (AuthIssue.code). */
export const CREDENTIAL_REFUSED_CODE = 'credential_refused';

/** Consecutive refused read calls before the connector is marked. */
export const REFUSALS_BEFORE_MARK = 3;

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

  /** One more refused call: how many this process has seen in a row. */
  refused(connectorId: string): number {
    if (this.refusals.size >= MAX_TRACKED && !this.refusals.has(connectorId)) this.refusals.clear();
    const count = (this.refusals.get(connectorId) ?? 0) + 1;
    this.refusals.set(connectorId, count);
    this.settled.delete(connectorId);
    return count;
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

/**
 * Whether the status of a connector with `count` refusals in a row is written
 * now: at the threshold, and again every 100 refusals after it, to bring the
 * count in its message up to date. (A connector past the threshold with no
 * status at all, because an edit cleared it without fixing the key, is marked
 * at its next refusal whatever the count: dynamic-mcp-tools.ts.)
 */
export function marksAt(count: number): boolean {
  return count === REFUSALS_BEFORE_MARK || (count > REFUSALS_BEFORE_MARK && count % 100 === 0);
}

/** Auth types whose credential, when there is one, sits in the URL or the body (a Telegram token, an Odoo JSON-RPC key). */
export const UNDECLARED_CREDENTIAL_AUTH_TYPES = new Set(['NONE']);

/**
 * The status message, read by the workspace owner on the dashboard and in the
 * email: what happened, then the adapter's or the generic advice.
 */
export function credentialRefusedMessage(count: number, advice: string | undefined, status?: number): string {
  const text =
    `The API refused this connector's saved credentials on ${count} calls in a row${status ? ` (HTTP ${status})` : ''}. ` +
    (advice?.trim() ||
      'They were revoked, expired or changed at the provider: enter valid ones in the connector\'s settings.');
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}
