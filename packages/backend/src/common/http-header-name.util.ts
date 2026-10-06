/**
 * HTTP header names are RFC 9110 "tokens": letters, digits and a few symbols,
 * no spaces. Node refuses anything else at send time with "Header name must be
 * a valid HTTP token", which tells the user nothing. In production that came
 * from the API-key form, where people typed the label of their key
 * ("Valentino API Key", "API Odoo") into Header Name.
 */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function isValidHeaderName(name: string): boolean {
  return HTTP_TOKEN.test(name);
}

/** Header names a connector would send that Node will refuse. */
export function invalidConnectorHeaderNames(
  headers?: Record<string, unknown> | null,
  authConfig?: Record<string, unknown> | null,
): string[] {
  const names = [
    ...Object.keys(headers ?? {}),
    ...[authConfig?.headerName, (authConfig?.signature as Record<string, unknown> | undefined)?.headerName]
      .filter((v): v is string => typeof v === 'string' && v !== ''),
  ];
  return names.filter((n) => !isValidHeaderName(n));
}

export function describeInvalidHeaderNames(names: string[]): string {
  const list = names.map((n) => `"${n}"`).join(', ');
  return (
    `${list} ${names.length === 1 ? 'is not a valid HTTP header name' : 'are not valid HTTP header names'}: ` +
    `use letters, digits and "-" only, no spaces. In the authentication settings, Header Name is the header ` +
    `the key travels in (for example X-API-Key), not the name you gave the key.`
  );
}
