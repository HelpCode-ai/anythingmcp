/**
 * `authConfig.tokenResponsePath` (OAUTH2, opt-in): where the token fields sit
 * in a token endpoint's answer when they are not at the top level.
 *
 * RFC 6749 §5.1 puts `access_token`, `refresh_token` and `expires_in` at the
 * top of the JSON answer, and that is where they are read. A few providers
 * wrap them: Joom answers
 * `{ "code": 0, "message": "", "data": { "access_token": …, "refresh_token": …, "expires_in": … } }`.
 * Such an adapter names the wrapper (`"tokenResponsePath": "data"`), and the
 * authorization-code exchange and every renewal read the token fields from
 * the object at that path.
 *
 * With the field unset none of this runs: the answer is read as before.
 */

const MAX_VENDOR_FIELD_LEN = 120;

/** The configured path, or undefined when the field is unset or blank. */
export function tokenResponsePathOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The object at the dotted `path` of a token answer (`data`, `result.token`),
 * or undefined when the answer has none there. Only own properties are
 * followed, and only an object counts: a string, a number, a list or null
 * at the path is "missing".
 */
export function tokenFieldsAt(body: unknown, path: string): Record<string, any> | undefined {
  let cur: unknown = body;
  for (const key of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, any>)
    : undefined;
}

/**
 * Why a wrapped token answer could not be read, in words that are safe to
 * show: the path, plus the provider's own top-level `code` and `message`
 * (how these APIs report a refused code or refresh token inside a 200).
 * Nothing else of the answer is quoted, so a token that sits somewhere
 * unexpected never ends up in a message or a log line.
 */
export function describeMissingTokenFields(body: unknown, path: string): string {
  const said: string[] = [];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { code, message } = body as Record<string, unknown>;
    if (typeof code === 'number' || (typeof code === 'string' && code.trim() !== '')) {
      said.push(`code ${String(code).slice(0, MAX_VENDOR_FIELD_LEN)}`);
    }
    if (typeof message === 'string' && message.trim() !== '') {
      said.push(message.trim().slice(0, MAX_VENDOR_FIELD_LEN));
    }
  }
  return (
    `the token answer has no object at "${path}" (authConfig.tokenResponsePath)` +
    (said.length > 0 ? `; the provider answered: ${said.join(': ')}` : '')
  );
}
