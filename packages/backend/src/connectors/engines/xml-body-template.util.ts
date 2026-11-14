import { escapeXmlValue } from '../../common/xml-escape.util';

/**
 * Optional and repeated blocks in an XML body template (`bodyEncoding: "xml"`).
 *
 * An API that validates its requests against a schema refuses an element that
 * is there but empty (`<paging></paging>` where an integer is expected), so a
 * template needs a way to leave an optional element out, and to repeat one per
 * item of a list. Fnac Darty's marketplace API answers such a request with
 * "XML Schema Validation failed".
 *
 *   ${?name}…${/name}        the block is kept when `name` has a value
 *   ${?a|b}…${/a|b}          … when `a` or `b` has one
 *   ${*items}…${/items}      the block is repeated for every item of the list
 *                            `items` (a single value counts as a list of one)
 *
 * Inside a repeated block `${.}` is the item itself, and the fields of an
 * object item are placeholders of their own (`${sku}`), on top of the call's
 * parameters. "Has a value" means not missing, not null, not an empty string
 * and not an empty list; `0` and `false` are values.
 *
 * Blocks nest, also under the same name: `${?ids}<ids>${*ids}<id>${.}</id>${/ids}</ids>${/ids}`
 * sends the wrapper only when there are ids. A block that is opened and never
 * closed is a mistake in the template and stops the call before anything is
 * sent.
 *
 * A template without `${?` and `${*` never reaches this file: the REST engine
 * renders it exactly as it did before blocks existed.
 */

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const OPTIONAL_EXPR = new RegExp(`^${NAME}(?:\\|${NAME})*$`);
const REPEATED_EXPR = new RegExp(`^${NAME}$`);
// `${name}`, and `${.}` for the item of a repeated block.
const PLACEHOLDER = new RegExp(`\\$\\{(${NAME}|\\.)\\}`, 'g');

/** Whether a template uses optional or repeated blocks. */
export function hasXmlTemplateBlocks(template: string): boolean {
  return template.includes('${?') || template.includes('${*');
}

function own(scope: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(scope, name) ? scope[name] : undefined;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

function substitute(text: string, scope: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = own(scope, name);
    if (value === undefined || value === null) return '';
    return escapeXmlValue(typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
}

/**
 * Where the block opened just before `from` closes: the `${/expr}` that
 * matches it, skipping the closing tags of blocks with the same name opened
 * in between. -1 when there is none.
 */
function findClose(template: string, from: number, expr: string): number {
  const closeTag = `\${/${expr}}`;
  const openers = [`\${?${expr}}`, `\${*${expr}}`];
  let depth = 1;
  let pos = from;
  for (;;) {
    const close = template.indexOf(closeTag, pos);
    if (close === -1) return -1;
    let nested = -1;
    for (const opener of openers) {
      const at = template.indexOf(opener, pos);
      if (at !== -1 && at < close && (nested === -1 || at < nested)) nested = at;
    }
    if (nested !== -1) {
      depth += 1;
      pos = nested + openers[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return close;
    pos = close + closeTag.length;
  }
}

/**
 * Render a template that uses blocks. `locked` holds the values the engine
 * supplies itself (the login token): an item of a repeated block cannot
 * replace them.
 */
export function renderXmlTemplateBlocks(
  template: string,
  params: Record<string, unknown>,
  locked: Record<string, unknown> = {},
): string {
  return render(template, { ...params, ...locked }, locked);
}

function render(
  template: string,
  scope: Record<string, unknown>,
  locked: Record<string, unknown>,
): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const optional = template.indexOf('${?', pos);
    const repeated = template.indexOf('${*', pos);
    const open =
      optional === -1 ? repeated : repeated === -1 ? optional : Math.min(optional, repeated);
    if (open === -1) return out + substitute(template.slice(pos), scope);

    out += substitute(template.slice(pos, open), scope);
    const kind = template[open + 2] as '?' | '*';
    const tagEnd = template.indexOf('}', open);
    const expr = tagEnd === -1 ? '' : template.slice(open + 3, tagEnd);
    if (!(kind === '?' ? OPTIONAL_EXPR : REPEATED_EXPR).test(expr)) {
      throw new Error(
        `bodyTemplate: "\${${kind}" must be followed by a parameter name` +
          (kind === '?' ? ' (or several, separated by "|")' : '') +
          ' and "}"',
      );
    }
    const closeTag = `\${/${expr}}`;
    const close = findClose(template, tagEnd + 1, expr);
    if (close === -1) {
      throw new Error(`bodyTemplate: the block \${${kind}${expr}} is never closed with ${closeTag}`);
    }
    const inner = template.slice(tagEnd + 1, close);

    if (kind === '?') {
      if (expr.split('|').some((name) => hasValue(own(scope, name)))) {
        out += render(inner, scope, locked);
      }
    } else {
      const value = own(scope, expr);
      const items = !hasValue(value) ? [] : Array.isArray(value) ? value : [value];
      for (const item of items) {
        const fields =
          item !== null && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : {};
        out += render(inner, { ...scope, ...fields, '.': item, ...locked }, locked);
      }
    }
    pos = close + closeTag.length;
  }
}
