import { interpolateString } from '../common/env-interpolation.util';
import { CALLER_CONTEXT_PREFIX } from '../common/caller-context.util';

/**
 * Re-resolve a catalog connector's credentials after its environment variables
 * were edited — without destroying credentials that still work.
 *
 * A catalog install resolves the adapter's `{{VAR}}` templates once and stores
 * the result (authConfig encrypted, base URL and headers in the clear). Editing
 * the variables has to reach those copies, or the form shows a new key while
 * every call still signs with the old one. Rebuilding them wholesale from the
 * template, as this used to do, had three side effects:
 *
 *   - a credential corrected in the auth editor (e.g. an OAuth 1.0a consumer
 *     key fixed with PATCH :id/oauth1-config) was replaced by whatever the
 *     variable held, even when the user had only edited an unrelated variable;
 *   - anything stored next to the template's fields (tokens issued by an OAuth
 *     authorization, a custom header, a base URL pointed at a sandbox) was
 *     dropped;
 *   - an install whose variable names predate the current template (IS24
 *     installs from before #712 hold IS24_CLIENT_ID, the template now wants
 *     IS24_CONSUMER_KEY) got the literal `{{IS24_CONSUMER_KEY}}` as its key.
 *
 * So each templated field is only rebuilt when one of the variables it
 * references actually changed, or when the stored value is missing or still
 * holds a placeholder. A field that would come out with an unresolved
 * placeholder keeps its stored value, and the variable is reported. Variables
 * the adapter declares as renamed (`envVarAliases`) are read under their old
 * name when the new one is not set.
 */

const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

export interface CatalogTemplate {
  connector: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  /** New variable name → names it had in earlier versions of the adapter. */
  envVarAliases?: Record<string, string[]>;
}

export interface RebuildInput {
  adapter: CatalogTemplate;
  connectorAuthType: string;
  storedAuthConfig: Record<string, unknown> | null;
  storedBaseUrl: string;
  storedHeaders: Record<string, string> | null;
  previousEnvVars: Record<string, string>;
  nextEnvVars: Record<string, string>;
}

export interface MissingVariable {
  variable: string;
  /** The field that references it, e.g. `authConfig.consumerKey`. */
  field: string;
  /** Whether a stored value was kept (false: nothing was stored to keep). */
  kept: boolean;
}

export interface RebuildResult {
  /** Only set when something changed. */
  authConfig?: Record<string, unknown>;
  baseUrl?: string;
  headers?: Record<string, string>;
  missing: MissingVariable[];
  /** Variables read under a previous name, e.g. IS24_CONSUMER_KEY ← IS24_CLIENT_ID. */
  aliasesUsed: Array<{ variable: string; from: string }>;
  /** Authconfig field → variables its template references. */
  authFieldVariables: Record<string, string[]>;
}

function placeholders(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(VAR_PATTERN)) {
    const name = match[1].trim();
    // Resolved per call from the MCP session, never from env vars.
    if (!name.startsWith(CALLER_CONTEXT_PREFIX)) names.add(name);
  }
  return [...names];
}

/** The variables with renamed ones filled in under their current name. */
export function withAliases(
  envVars: Record<string, string>,
  aliases: Record<string, string[]> | undefined,
  used?: Array<{ variable: string; from: string }>,
): Record<string, string> {
  const out = { ...envVars };
  for (const [variable, previousNames] of Object.entries(aliases ?? {})) {
    if (out[variable]) continue;
    const from = previousNames.find((name) => envVars[name]);
    if (from) {
      out[variable] = envVars[from];
      used?.push({ variable, from });
    }
  }
  return out;
}

export function rebuildCatalogCredentials(input: RebuildInput): RebuildResult {
  const aliasesUsed: Array<{ variable: string; from: string }> = [];
  const previous = withAliases(input.previousEnvVars, input.adapter.envVarAliases);
  const next = withAliases(
    input.nextEnvVars,
    input.adapter.envVarAliases,
    aliasesUsed,
  );
  const changed = (name: string) => (previous[name] ?? '') !== (next[name] ?? '');
  const missing: MissingVariable[] = [];
  const authFieldVariables: Record<string, string[]> = {};

  /** Decide one templated string field. */
  const resolveField = (
    template: string,
    stored: unknown,
    field: string,
  ): unknown => {
    const vars = placeholders(template);
    if (vars.length === 0) return stored !== undefined ? stored : template;
    // A stored `{{VAR}}` that the variables can resolve works at call time
    // (which knows nothing of aliases); one they cannot is what an earlier
    // wholesale rebuild left behind.
    const storedIsBroken =
      typeof stored === 'string' &&
      placeholders(stored).some((name) => !input.nextEnvVars[name]);
    const needsRebuild =
      stored === undefined || storedIsBroken || vars.some(changed);

    const resolved = interpolateString(template, next);
    const unresolved = placeholders(resolved);
    // Reported even when the field is left alone: someone editing
    // IS24_CLIENT_ID on an old install should learn that the connector reads
    // IS24_CONSUMER_KEY, not see the save succeed and nothing change.
    for (const variable of unresolved) {
      missing.push({ variable, field, kept: stored !== undefined });
    }
    if (!needsRebuild) return stored;
    if (unresolved.length === 0) return resolved;
    // Keep what works. With nothing stored, the placeholder stays, and the
    // call-time check names the variable to set.
    return stored !== undefined ? stored : resolved;
  };

  /** Walk a template object against its stored copy, field by field. */
  const resolveObject = (
    template: Record<string, unknown>,
    stored: Record<string, unknown>,
    path: string,
    onString?: (field: string, template: string) => void,
  ): Record<string, unknown> => {
    // Start from the stored copy: fields the template does not know about
    // (issued tokens, a token added by hand) are kept as they are.
    const out: Record<string, unknown> = { ...stored };
    for (const [key, tmpl] of Object.entries(template)) {
      const field = `${path}.${key}`;
      const current = Object.prototype.hasOwnProperty.call(stored, key)
        ? stored[key]
        : undefined;
      if (typeof tmpl === 'string') {
        onString?.(field, tmpl);
        out[key] = resolveField(tmpl, current, field);
      } else if (tmpl && typeof tmpl === 'object' && !Array.isArray(tmpl)) {
        const nested =
          current && typeof current === 'object' && !Array.isArray(current)
            ? (current as Record<string, unknown>)
            : {};
        out[key] = resolveObject(
          tmpl as Record<string, unknown>,
          nested,
          field,
          onString,
        );
      } else if (current === undefined) {
        out[key] = tmpl;
      }
    }
    return out;
  };

  const result: RebuildResult = { missing, aliasesUsed, authFieldVariables };

  // A connector switched to another auth type in the editor no longer matches
  // the template; its credentials are the editor's business.
  const template = input.adapter.connector;
  if (template.authConfig && input.connectorAuthType === template.authType) {
    const stored = input.storedAuthConfig ?? {};
    const rebuilt = resolveObject(
      template.authConfig,
      stored,
      'authConfig',
      (field, tmpl) => {
        authFieldVariables[field.slice('authConfig.'.length)] = placeholders(tmpl);
      },
    );
    if (JSON.stringify(rebuilt) !== JSON.stringify(stored)) {
      result.authConfig = rebuilt;
    }
  }

  const baseUrl = resolveField(template.baseUrl, input.storedBaseUrl, 'baseUrl');
  if (typeof baseUrl === 'string' && baseUrl !== input.storedBaseUrl) {
    result.baseUrl = baseUrl;
  }

  if (template.headers) {
    const stored = input.storedHeaders ?? {};
    const rebuilt = resolveObject(template.headers, stored, 'headers') as Record<
      string,
      string
    >;
    if (JSON.stringify(rebuilt) !== JSON.stringify(stored)) {
      result.headers = rebuilt;
    }
  }

  return result;
}

/** One sentence per variable, for the editor. */
export function describeMissing(missing: MissingVariable[]): string[] {
  const byVariable = new Map<string, { kept: string[]; unset: string[] }>();
  for (const { variable, field, kept } of missing) {
    const entry = byVariable.get(variable) ?? { kept: [], unset: [] };
    const list = kept ? entry.kept : entry.unset;
    if (!list.includes(field)) list.push(field);
    byVariable.set(variable, entry);
  }
  return [...byVariable.entries()].map(([variable, { kept, unset }]) => {
    const parts: string[] = [];
    if (kept.length) parts.push(`${kept.join(' and ')} kept its stored value`);
    if (unset.length) parts.push(`${unset.join(' and ')} has no value yet`);
    return `${variable} is not set, so ${parts.join('; ')}. Add ${variable} to change it.`;
  });
}
