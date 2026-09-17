/**
 * Catches a request that still carries `{{VAR}}` after interpolation.
 *
 * WHY. A connector installed without its credentials keeps the adapter's
 * placeholders verbatim, and we used to send them upstream as if they were the
 * secret. The vendor then answers with its own complaint about the shape of the
 * value, which reads like our bug and never mentions the real cause. One real
 * case on 2026-09-17: an Etsy connector with no `ETSY_CLIENT_ID` sent
 * `x-api-key: {{ETSY_CLIENT_ID}}:{{ETSY_CLIENT_SECRET}}` and Etsy answered
 * `Invalid API key: should be in the format 'keystring:shared_secret'` — the
 * same sentence that had just cost us a customer's afternoon, this time meaning
 * something completely different.
 *
 * So: refuse to make the call, and name the variables the workspace has to set.
 * Only auth, base URL, path and headers are checked. A body may legitimately
 * carry braces (a template the upstream itself renders), and a wrong body is
 * the caller's business, not a missing credential.
 */

const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

/** Every `{{VAR}}` name still present anywhere in the value, deduplicated. */
export function findUnresolvedPlaceholders(value: unknown): string[] {
  const found = new Set<string>();

  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(VAR_PATTERN)) {
        found.add(match[1].trim());
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };

  walk(value);
  return [...found];
}

export interface RequestShape {
  baseUrl?: string;
  path?: string;
  headers?: Record<string, string> | null;
  authConfig?: unknown;
}

/**
 * Throws when the request still references a variable nobody has set.
 *
 * The message is written for the person reading a tool error in a chat client:
 * it names the connector, the variables, and where to put them.
 */
export function assertNoUnresolvedPlaceholders(
  request: RequestShape,
  /** How to name the thing in the error, e.g. `the connector behind etsy_get_shop`. */
  subject?: string,
): void {
  const missing = findUnresolvedPlaceholders({
    baseUrl: request.baseUrl,
    path: request.path,
    headers: request.headers ?? undefined,
    authConfig: request.authConfig,
  });
  if (missing.length === 0) return;

  const names = missing.sort().join(', ');
  const which = subject ? `${subject[0].toUpperCase()}${subject.slice(1)}` : 'This connector';
  throw new Error(
    `${which} is missing ${missing.length === 1 ? 'a value' : 'values'} for ${names}. ` +
      'The request was not sent, because it would have carried the placeholder text ' +
      'instead of the credential and the upstream API would have rejected it with a ' +
      'misleading error. Open the connector and set ' +
      `${missing.length === 1 ? 'that variable' : 'those variables'}, then try again.`,
  );
}
