/**
 * Errors that arrive inside a successful HTTP response.
 *
 * Some APIs answer every request with HTTP 200 and say in the body whether it
 * worked: PeopleHR puts a `Status` code next to the data (0 success, 5
 * "API Key does not exists."), Korea's law.go.kr answers
 * `{"result": "사용자 정보 검증에 실패하였습니다.", "msg": ...}` instead of the
 * search result. Passed on as a body, such a call counted as a success: the
 * install probe reported a working connector with a wrong key, and the model
 * had to notice the refusal on its own.
 *
 * An adapter describes its error shape in `connector.config.errorWhen`, a
 * rule or a list of rules checked in order; the first that matches turns the
 * response into a {@link ResponseBodyError}. Connectors without rules are not
 * affected.
 */

export interface ErrorWhenRule {
  /** Dotted path into the parsed body (`Status`, `error.code`, `items[0].ok`). */
  path: string;
  /**
   * The value at `path` equals this one. Scalars compare as text, so `5`
   * matches both `5` and `"5"`; vendors are not consistent about it.
   */
  equals?: string | number | boolean | null;
  /** The value at `path` is one of these (compared like `equals`). */
  in?: Array<string | number | boolean | null>;
  /** The value at `path`, as text, matches this case-insensitive regex. */
  matches?: string;
  /**
   * Where the error text is. A list is joined with a space. Defaults to the
   * value at `path` when that is a string.
   */
  messagePath?: string | string[];
  /** The rule only applies when the error text matches this regex as well. */
  messageMatches?: string;
  /**
   * The HTTP-like status the error reports, which is what classifies it:
   * 401/403 auth_failed, 400/422 bad_request, 404 not_found, 429
   * rate_limited, 5xx upstream_error. Default 400.
   */
  status?: number;
}

/**
 * A response that came back 2xx but carried an error the adapter described.
 * `status` is the one the matching rule assigns, not the HTTP status (that
 * was 2xx); the install probe and the error classifier read it like an HTTP
 * status, which is the point.
 */
export class ResponseBodyError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = 'ResponseBodyError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/** The rules in `connector.config.errorWhen`, normalized to a list. */
export function errorWhenRules(value: unknown): ErrorWhenRule[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (r): r is ErrorWhenRule =>
      !!r && typeof r === 'object' && typeof (r as ErrorWhenRule).path === 'string',
  );
}

/**
 * Problems with a rule list, for the adapter validator and the catalog spec.
 * Empty when the rules are usable.
 */
export function describeErrorWhenProblems(value: unknown): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const problems: string[] = [];
  list.forEach((rule, i) => {
    const at = Array.isArray(value) ? `errorWhen[${i}]` : 'errorWhen';
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.path !== 'string' || !r.path) problems.push(`${at}.path must be a non-empty string`);
    if (r.in !== undefined && !Array.isArray(r.in)) problems.push(`${at}.in must be an array`);
    for (const key of ['matches', 'messageMatches'] as const) {
      if (r[key] === undefined) continue;
      try {
        new RegExp(String(r[key]), 'i');
      } catch {
        problems.push(`${at}.${key} is not a valid regular expression`);
      }
    }
    if (
      r.status !== undefined &&
      !(typeof r.status === 'number' && Number.isInteger(r.status) && r.status >= 400 && r.status <= 599)
    ) {
      problems.push(`${at}.status must be an HTTP error status (400-599)`);
    }
    const known = new Set(['path', 'equals', 'in', 'matches', 'messagePath', 'messageMatches', 'status']);
    for (const key of Object.keys(r)) {
      if (!known.has(key)) problems.push(`${at}.${key} is not a known field`);
    }
  });
  return problems;
}

/** Throw a {@link ResponseBodyError} when a rule matches the body. */
export function assertNoResponseBodyError(body: unknown, rules: unknown): void {
  const list = errorWhenRules(rules);
  if (list.length === 0 || body === null || typeof body !== 'object') return;
  for (const rule of list) {
    const value = readPath(body, rule.path);
    if (value === undefined) continue;
    if (!valueMatches(value, rule)) continue;
    const message = errorMessage(body, rule, value);
    if (rule.messageMatches !== undefined && !safeRegex(rule.messageMatches)?.test(message)) {
      continue;
    }
    const status = typeof rule.status === 'number' ? rule.status : 400;
    throw new ResponseBodyError(
      `The API answered with an error in a successful response: ${message.slice(0, 1000)}`,
      status,
      body,
    );
  }
}

function valueMatches(value: unknown, rule: ErrorWhenRule): boolean {
  const hasEquals = Object.prototype.hasOwnProperty.call(rule, 'equals');
  if (hasEquals && !sameScalar(value, rule.equals)) return false;
  if (Array.isArray(rule.in) && !rule.in.some((candidate) => sameScalar(value, candidate))) {
    return false;
  }
  if (rule.matches !== undefined) {
    if (value === null || typeof value === 'object') return false;
    if (!safeRegex(rule.matches)?.test(String(value))) return false;
  }
  if (!hasEquals && rule.in === undefined && rule.matches === undefined) {
    // Bare path: the field is there and says something.
    return value !== null && value !== false && value !== '' && value !== 0;
  }
  return true;
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(a) === String(b);
}

function errorMessage(body: unknown, rule: ErrorWhenRule, value: unknown): string {
  const paths =
    rule.messagePath === undefined
      ? []
      : Array.isArray(rule.messagePath)
        ? rule.messagePath
        : [rule.messagePath];
  const parts = paths
    .map((p) => readPath(body, p))
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => (typeof v === 'string' ? v.trim() : JSON.stringify(v)));
  if (parts.length > 0) return parts.join(' ');
  if (typeof value === 'string' && value.trim()) return value.trim();
  return `${rule.path} is ${JSON.stringify(value)}`;
}

/** `a.b[0].c` against a parsed body; undefined when any step is missing. */
function readPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}
