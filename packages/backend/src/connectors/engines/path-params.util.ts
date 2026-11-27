/**
 * Building a REST request URL from a tool's path template and the values of
 * its `{param}` placeholders.
 *
 * A value fills a place in the path the tool chose; it does not choose the
 * host, and it does not choose another endpoint than the one the template
 * names. So:
 *  - whether the request goes to the connector's base URL or to a URL of its
 *    own is decided on the template, before any value is substituted. A
 *    template that is itself an absolute URL keeps that URL; any other
 *    template is joined to the base URL, and the result must stay on the base
 *    URL's origin;
 *  - a value substituted as is (the tool did not set `encodePathParams`) may
 *    carry `/` (some tools pass a sub-path on purpose), but not what would
 *    leave its place: a `..` segment, `#`, `\`, a control character, a scheme
 *    (`://`), or `?`. `?` is accepted only in a placeholder that ends the
 *    template, where it cannot cut off the rest of the path (a `nextUrl`
 *    that the API hands back with its query string);
 *  - with `encodePathParams`, the value is percent-encoded and only a value
 *    that is a whole `.` or `..` segment is refused;
 *  - a placeholder inside the template's own query string (`?tag_id={id}`)
 *    only refuses control characters and `#`.
 */

export class PathParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathParameterError';
  }
}

const PLACEHOLDER = /\{([^{}]+)\}/g;
/** C0 control characters and DEL. */
const CONTROL = {
  test(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  },
};

/** True for a template that names its own `http(s)://` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** `.` or `..`, also written with `%2e`, as a URL parser reads it. */
function isDotSegment(segment: string): boolean {
  const s = segment.replace(/%2e/gi, '.');
  return s === '.' || s === '..';
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some(isDotSegment);
}

/**
 * Throws PathParameterError when a value substituted as is would leave its
 * place in the path. `atEnd`: the placeholder ends the template.
 */
export function assertPathValueStaysInPlace(name: string, value: string, atEnd: boolean): void {
  const refuse = (what: string) => {
    throw new PathParameterError(
      `The value of the path parameter "${name}" contains ${what}, which is not accepted in a URL path. ` +
        'Pass the identifier itself.',
    );
  };
  if (CONTROL.test(value)) refuse('a control character');
  if (value.includes('#')) refuse('"#"');
  const query = value.indexOf('?');
  if (query !== -1 && !atEnd) refuse('"?"');
  const pathPart = query === -1 ? value : value.slice(0, query);
  if (pathPart.includes('\\')) refuse('"\\"');
  if (pathPart.includes('://')) refuse('a URL scheme ("://")');
  if (hasDotSegment(pathPart)) refuse('a "." or ".." segment');
}

/**
 * Substitutes the first `{name}` of each parameter in `params` into
 * `template`, in one pass: a substituted value is never searched for further
 * placeholders. Placeholders without a parameter stay as they are.
 */
export function substitutePathParams(
  template: string,
  params: Record<string, unknown>,
  encode: boolean,
): string {
  const used = new Set<string>();
  const queryStart = template.indexOf('?');
  const result = template.replace(PLACEHOLDER, (match, name: string, offset: number) => {
    if (used.has(name) || !Object.prototype.hasOwnProperty.call(params, name)) return match;
    used.add(name);
    const raw = String(params[name]);
    if (queryStart !== -1 && offset > queryStart) {
      // A placeholder in the template's own query string (`?tag_id={id}`)
      // cannot change the path or the host.
      if (encode) return encodeURIComponent(raw);
      if (CONTROL.test(raw) || raw.includes('#')) {
        throw new PathParameterError(
          `The value of the parameter "${name}" contains a control character or "#", which is not accepted in a URL.`,
        );
      }
      return raw;
    }
    if (encode) {
      if (isDotSegment(raw)) {
        throw new PathParameterError(
          `The value of the path parameter "${name}" is "${raw}", which is not accepted as a URL path segment.`,
        );
      }
      return encodeURIComponent(raw);
    }
    assertPathValueStaysInPlace(name, raw, offset + match.length === template.length);
    return raw;
  });
  // Values next to template text can still form a dot segment ("/a/.{x}"
  // with "."): check the result, unless the template has one itself.
  const pathOf = (p: string) => p.split(/[?#]/, 1)[0];
  if (!hasDotSegment(pathOf(template)) && hasDotSegment(pathOf(result))) {
    throw new PathParameterError(
      'A path parameter value forms a "." or ".." segment in the URL path, which is not accepted.',
    );
  }
  return result;
}

/**
 * Throws PathParameterError unless `url` is on the origin of `baseUrl`. A
 * base URL that does not parse is left to the outbound URL check, which
 * reports it.
 */
export function assertSameOrigin(url: string, baseUrl: string): void {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PathParameterError('The request URL built from the tool path is not a valid URL.');
  }
  if (target.origin !== base.origin) {
    throw new PathParameterError(
      "The request URL built from the tool path leaves the connector's base URL " +
        `(${base.origin}). A path parameter value cannot change the host.`,
    );
  }
}
