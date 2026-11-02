import { outboundRequest } from '../common/outbound-http';

/**
 * Settings a connector needs that the user should not have to find: looked up
 * at setup from a value they do know, and stored with the connector's other
 * variables.
 *
 * WHY. Atlassian's Rovo MCP server takes an API token that is not bound to a
 * site, so almost every tool needs the site's cloudId. Nobody knows their
 * cloudId, and the tool that should list it (getAccessibleAtlassianResources)
 * could not be shown to work with API tokens. The site's public
 * `https://<site>/_edge/tenant_info` answers `{"cloudId": "…"}` without
 * credentials, so the user types `mycompany.atlassian.net` and AnythingMCP
 * stores the cloudId next to it.
 *
 * An adapter declares them as `derivedEnvVars`:
 *
 * ```json
 * "derivedEnvVars": {
 *   "ATLASSIAN_CLOUD_ID": {
 *     "fromHost": "ATLASSIAN_SITE",
 *     "url": "https://{{ATLASSIAN_SITE}}/_edge/tenant_info",
 *     "path": "cloudId",
 *     "pattern": "^[0-9a-f-]{36}$",
 *     "error": "No Atlassian site answers at {{host}}."
 *   }
 * }
 * ```
 *
 * The source is always a host: `https://Acme.atlassian.net/` is stored as
 * `acme.atlassian.net`. The lookup is one unauthenticated GET through the
 * SSRF-guarded client, and the source variable's own pattern has been checked
 * before (env-var-checks.ts), so the address is one the adapter accepts.
 */
export interface DerivedEnvVar {
  /** The variable holding the host to ask, e.g. ATLASSIAN_SITE. */
  fromHost: string;
  /** Public GET; `{{<fromHost>}}` is replaced by the bare host. */
  url: string;
  /** Dotted path of the value in the JSON answer. */
  path: string;
  /** What the value must look like (a regular expression). */
  pattern?: string;
  /** The field message when the host gives no value; `{{host}}` is replaced. */
  error: string;
}

export interface DerivedOutcome {
  /** Values to store: each derived setting found, and its source as a bare host. */
  values: Record<string, string>;
  /** Derived settings to remove: the source is empty, or no value was found for it. */
  clear: string[];
  /** The source variable → why no value was found, for the form. */
  fields: Record<string, string>;
}

/** Answers a GET with its status and parsed JSON body; throws when nothing answered. */
export type DerivedFetch = (url: string) => Promise<{ status: number; data: unknown }>;

const LOOKUP_TIMEOUT_MS = 8000;

/** `https://Acme.atlassian.net/wiki/` → `acme.atlassian.net`; undefined when no host can be read. */
export function bareHost(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

const defaultFetch: DerivedFetch = async (url) => {
  const response = await outboundRequest({
    method: 'GET',
    url,
    timeout: LOOKUP_TIMEOUT_MS,
    validateStatus: () => true,
    headers: { Accept: 'application/json' },
    responseType: 'json',
  });
  return { status: response.status, data: response.data };
};

function valueAt(data: unknown, path: string): unknown {
  let value: unknown = typeof data === 'string' ? safeJson(data) : data;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function matches(pattern: string | undefined, value: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

/**
 * Look up the adapter's derived settings from these values. With `only`, just
 * the derived settings whose source is among those names (an edit that did
 * not touch the site does not ask again).
 *
 * A definite answer without a value (the host answers 404, or JSON without
 * the field) is a field error on the source. No answer at all (a timeout, a
 * 5xx) is neither a value nor an error: the setup goes on without the
 * setting, and the connector's instructions fall back to asking the model to
 * find it.
 */
export async function resolveDerivedEnvVars(
  adapter: { derivedEnvVars?: Record<string, DerivedEnvVar> },
  values: Record<string, unknown>,
  opts: { only?: Iterable<string>; fetch?: DerivedFetch } = {},
): Promise<DerivedOutcome> {
  const out: DerivedOutcome = { values: {}, clear: [], fields: {} };
  const derived = adapter.derivedEnvVars;
  if (!derived) return out;
  const only = opts.only ? new Set(opts.only) : undefined;
  const fetch = opts.fetch ?? defaultFetch;
  for (const [name, spec] of Object.entries(derived)) {
    if (only && !only.has(spec.fromHost)) continue;
    const raw = values[spec.fromHost];
    const host = typeof raw === 'string' ? bareHost(raw) : undefined;
    if (!host) {
      out.clear.push(name);
      continue;
    }
    out.values[spec.fromHost] = host;
    const url = spec.url.split(`{{${spec.fromHost}}}`).join(host);
    let answer: { status: number; data: unknown };
    try {
      answer = await fetch(url);
    } catch {
      // A value stored for an earlier host would now be wrong: drop it.
      out.clear.push(name);
      continue;
    }
    if (answer.status >= 500 || answer.status === 429) {
      out.clear.push(name);
      continue;
    }
    const found = answer.status < 300 ? valueAt(answer.data, spec.path) : undefined;
    const text = typeof found === 'string' ? found.trim() : '';
    if (text && matches(spec.pattern, text)) {
      out.values[name] = text;
    } else {
      out.clear.push(name);
      out.fields[spec.fromHost] = spec.error.split('{{host}}').join(host);
    }
  }
  return out;
}

/** The variables to store with the derived settings found (and stale ones dropped). */
export function withDerivedValues(
  envVars: Record<string, unknown> | null,
  derived: { values: Record<string, string>; clear: string[] },
): Record<string, unknown> | null {
  if (Object.keys(derived.values).length === 0 && derived.clear.length === 0) return envVars;
  const drop = new Set(derived.clear);
  const out = Object.fromEntries(
    Object.entries({ ...(envVars ?? {}), ...derived.values }).filter(([name]) => !drop.has(name)),
  );
  return Object.keys(out).length > 0 ? out : null;
}
