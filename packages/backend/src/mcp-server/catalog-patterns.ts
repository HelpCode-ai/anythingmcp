import { getAdapter } from '../adapters/catalog';

/**
 * The `pattern` a catalog tool declares on a string argument, checked before
 * the call is sent.
 *
 * WHY. Catalog adapters state the shape of 1,027 arguments as a regular
 * expression (a date, a comma-separated list of allowed words, an id), and
 * until now that was documentation only: a value that did not match still
 * went to the vendor, which answered with its own, often cryptic, refusal.
 * Etsy's `includes` was refused that way in 15 workspaces in one week
 * ("Invalid value (inventory) for enum(...)"), although the tool's
 * description says in plain words which tool returns the inventory.
 *
 * Which expressions are run. Only those written in the catalog (this
 * repository), and only while the installed tool still declares the very same
 * one: a workspace that edited or removed a pattern on its copy of the tool
 * is left alone, and an expression stored in a workspace's tool row is never
 * executed. The catalog's expressions are timed against hostile inputs in CI
 * (catalog-patterns.spec.ts), and a value longer than MAX_CHECKED_LENGTH is
 * not checked at all, so a slow expression cannot hold up the process.
 *
 * Hand-built tools and tools imported from an OpenAPI file are not checked:
 * their patterns come from third-party specifications of unknown quality.
 */

/** Values longer than this are passed through unchecked. */
export const MAX_CHECKED_LENGTH = 2_000;

interface PatternRule {
  param: string;
  source: string;
  regex: RegExp;
  /** The pattern is on the items of an array argument. */
  items: boolean;
  description?: string;
}

export interface PatternViolation {
  param: string;
  pattern: string;
  /** The refused value, shortened. */
  value: string;
  /** The argument's description from the catalog: it says the rule in words. */
  description?: string;
}

const rulesByTool = new Map<string, PatternRule[]>();

function compile(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || !source) return undefined;
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

/** The pattern rules of one catalog tool (empty for nearly every tool). */
function rulesOf(adapterSlug: string, toolName: string): PatternRule[] {
  const key = `${adapterSlug}\n${toolName}`;
  const known = rulesByTool.get(key);
  if (known) return known;

  const rules: PatternRule[] = [];
  const tool = getAdapter(adapterSlug)?.tools?.find((t) => t.name === toolName);
  const properties = (tool?.parameters as { properties?: Record<string, any> } | undefined)?.properties ?? {};
  for (const [param, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') continue;
    const description = typeof prop.description === 'string' ? prop.description : undefined;
    if (prop.type === 'string') {
      const regex = compile(prop.pattern);
      if (regex) rules.push({ param, source: prop.pattern, regex, items: false, description });
    } else if (prop.type === 'array' && prop.items?.type === 'string') {
      const regex = compile(prop.items.pattern);
      if (regex) rules.push({ param, source: prop.items.pattern, regex, items: true, description });
    }
  }
  rulesByTool.set(key, rules);
  return rules;
}

const shorten = (value: string) => (value.length > 120 ? `${value.slice(0, 119)}…` : value);

/**
 * The arguments that do not match the pattern their catalog tool declares.
 * `storedSchema` is the installed tool's own schema (`mcp_tools.parameters`);
 * `args` are the arguments the caller passed.
 */
export function catalogPatternViolations(
  adapterSlug: string | undefined,
  toolName: string,
  storedSchema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): PatternViolation[] {
  if (!adapterSlug) return [];
  const rules = rulesOf(adapterSlug, toolName);
  if (rules.length === 0) return [];

  const stored = (storedSchema as { properties?: Record<string, any> } | undefined)?.properties ?? {};
  const violations: PatternViolation[] = [];
  for (const rule of rules) {
    const declared = rule.items ? stored[rule.param]?.items?.pattern : stored[rule.param]?.pattern;
    if (declared !== rule.source) continue;

    const given = args[rule.param];
    const values = rule.items ? (Array.isArray(given) ? given : []) : [given];
    for (const value of values) {
      if (typeof value !== 'string' || value.length > MAX_CHECKED_LENGTH) continue;
      if (rule.regex.test(value)) continue;
      violations.push({
        param: rule.param,
        pattern: rule.source,
        value: shorten(value),
        ...(rule.description ? { description: rule.description } : {}),
      });
      break; // one refused item says enough about this argument
    }
  }
  return violations;
}

/** Raised before any request is sent; `code` reaches the client with the message. */
export class ArgumentPatternError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  constructor(readonly violations: PatternViolation[]) {
    super(patternErrorMessage(violations));
    this.name = 'ArgumentPatternError';
  }
}

/** What the assistant reads: the value, the rule in words, then the expression. */
export function patternErrorMessage(violations: PatternViolation[]): string {
  const parts = violations.map((v) => {
    const words = v.description?.trim().replace(/\s+/g, ' ') ?? '';
    const rule = words ? ` ${words.length > 600 ? `${words.slice(0, 599)}…` : words}` : '';
    return `\`${v.param}\` cannot be ${JSON.stringify(v.value)}.${rule} It must match ${v.pattern}`;
  });
  return (
    `${parts.join(' ')} No request was sent to the API: correct the ` +
    `${violations.length === 1 ? 'argument' : 'arguments'} and call again.`
  );
}
