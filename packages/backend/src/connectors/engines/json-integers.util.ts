import { randomBytes } from 'node:crypto';

/**
 * 64-bit integers in JSON, both ways, for APIs whose ids do not fit a
 * JavaScript number (SHEIN's goodsId: 5230236437987443003). JSON.parse rounds
 * every integer above Number.MAX_SAFE_INTEGER (2^53 - 1) to the nearest
 * double, so the id read from an order is not the id of the order any more,
 * and a JSON number in a tool call is rounded by the MCP client before it
 * reaches us. Two opt-ins, both off unless an adapter sets them:
 *
 *   connector.config.largeIntegers: "string"   (parseJsonKeepingLargeIntegers)
 *     every integer literal of a JSON answer outside the safe range becomes a
 *     string with its exact digits (and its sign); every other value parses
 *     exactly as JSON.parse parses it.
 *
 *   endpointMapping.bodyIntegers: ["infoList[].goodsId", "goodsIdList[]"]
 *     (stringifyWithIntegerLiterals) the body fields at these paths, given as
 *     digit strings, go out as JSON number literals with the same digits, for
 *     an API that wants a number there. No float conversion on the way.
 */

const SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER); // 9007199254740991

/** Whether a JSON integer literal (optional minus, digits) is outside the safe range. */
export function isUnsafeIntegerLiteral(literal: string): boolean {
  const digits = literal.startsWith('-') ? literal.slice(1) : literal;
  if (digits.length !== SAFE_DIGITS.length) return digits.length > SAFE_DIGITS.length;
  return digits > SAFE_DIGITS;
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * JSON.parse, except that an integer literal outside ±(2^53 - 1) becomes a
 * string with its exact digits. Throws exactly when JSON.parse(text) throws.
 *
 * A string-aware scan finds the number tokens outside strings; a token is
 * rewritten (wrapped in quotes) only when it is a whole integer literal in a
 * value position: after `[`, `,`, `:` or at the start, and followed by
 * whitespace, `,`, `]`, `}` or the end. Replacing a value by a string in the
 * same place keeps the text valid exactly when it was valid, so invalid JSON
 * still fails. Decimals and exponents (`1.5`, `1e30`) are left to JSON.parse,
 * as are numbers inside strings.
 */
export function parseJsonKeepingLargeIntegers(text: string): unknown {
  // Fast path: no run of 16 digits, nothing that could be unsafe.
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  let out = '';
  let last = 0;
  let prev = ''; // last non-whitespace character outside strings
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // Skip the string, escapes included.
      i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      prev = '"';
      continue;
    }
    if (c === '-' || isDigit(c)) {
      const start = i;
      if (text[i] === '-') i++;
      while (isDigit(text[i])) i++;
      let integer = i > start + (c === '-' ? 1 : 0);
      // A fraction or an exponent: a decimal number, left as it is.
      while (i < n && (isDigit(text[i]) || text[i] === '.' || text[i] === 'e' || text[i] === 'E' || text[i] === '+' || text[i] === '-')) {
        integer = false;
        i++;
      }
      const token = text.slice(start, i);
      const next = text[i];
      const valuePosition = prev === '' || prev === '[' || prev === ',' || prev === ':';
      const ends = next === undefined || isWs(next) || next === ',' || next === ']' || next === '}';
      if (integer && valuePosition && ends && /^-?(0|[1-9]\d*)$/.test(token) && isUnsafeIntegerLiteral(token)) {
        out += text.slice(last, start) + '"' + token + '"';
        last = i;
      }
      prev = token[token.length - 1];
      continue;
    }
    if (!isWs(c)) prev = c;
    i++;
  }
  return JSON.parse(last === 0 ? text : out + text.slice(last));
}

/** One step of a body path: a key, and whether it walks into each element of an array. */
interface PathStep {
  key: string;
  each: boolean;
}

const PATH_PATTERN = /^[A-Za-z0-9_$-]+(\[\])?(\.[A-Za-z0-9_$-]+(\[\])?)*$/;

/** Whether a `bodyIntegers` entry is a path this module understands (`a`, `a[]`, `a[].b`, `a.b[]`). */
export function isBodyIntegerPath(path: unknown): path is string {
  return typeof path === 'string' && PATH_PATTERN.test(path);
}

function parsePath(path: string): PathStep[] {
  return path.split('.').map((part) => (part.endsWith('[]') ? { key: part.slice(0, -2), each: true } : { key: part, each: false }));
}

/** Calls `visit(container, key)` for every slot a path names that exists in `root`. */
function walk(root: unknown, steps: PathStep[], visit: (container: Record<string, unknown> | unknown[], key: string | number) => void): void {
  if (steps.length === 0 || !root || typeof root !== 'object' || Array.isArray(root)) return;
  const [step, ...rest] = steps;
  const obj = root as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, step.key)) return;
  const value = obj[step.key];
  if (step.each) {
    if (!Array.isArray(value)) return;
    value.forEach((item, idx) => (rest.length === 0 ? visit(value, idx) : walk(item, rest, visit)));
    return;
  }
  if (rest.length === 0) visit(obj, step.key);
  else walk(value, rest, visit);
}

/**
 * The JSON text of `data`, with the values at `paths` written as number
 * literals. Each such value must be a whole number: a string of digits
 * (optional minus) is written with exactly those digits, a safe integer as
 * it is; anything else throws, naming the path. Absent fields and null are
 * left alone. `data` is not changed.
 */
export function stringifyWithIntegerLiterals(data: unknown, paths: string[]): string {
  const copy = JSON.parse(JSON.stringify(data ?? null));
  const nonce = randomBytes(8).toString('hex');
  const literals: string[] = [];
  for (const path of paths) {
    if (!isBodyIntegerPath(path)) throw new Error(`bodyIntegers: "${path}" is not a body path such as "items[].id"`);
    walk(copy, parsePath(path), (container, key) => {
      const value = (container as Record<string | number, unknown>)[key];
      if (value === undefined || value === null) return;
      let literal: string;
      if (typeof value === 'number' && Number.isSafeInteger(value)) literal = String(value);
      else if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value.trim())) literal = value.trim();
      else throw new Error(`The field ${path} must be a whole number written with digits only.`);
      (container as Record<string | number, unknown>)[key] = `@@amcp-int-${nonce}-${literals.length}@@`;
      literals.push(literal);
    });
  }
  const text = JSON.stringify(copy);
  if (literals.length === 0) return text;
  return text.replace(new RegExp(`"@@amcp-int-${nonce}-(\\d+)@@"`, 'g'), (_m, idx: string) => literals[Number(idx)]);
}
