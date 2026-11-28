import { findUnresolvedPlaceholders } from '../common/unresolved-placeholders.util';
import { rebuildCatalogCredentials, type CatalogTemplate } from './catalog-env-rebuild.util';
import {
  MAX_USER_VARIABLES,
  USER_VARIABLES_CONFIG_KEY,
  isVariableName,
  userCredentialModeOf,
} from './user-credential.util';
import { withTokenRenewal } from './engines/bearer-token-renewal.service';

/**
 * Switching a connector to per-user variables (user-credential.util).
 *
 * From the switch on, a call must never carry the connector's own value of a
 * variable that each user enters. Emptying the variable is not enough: a
 * catalog install resolves its `{{VAR}}` templates once and stores the result
 * (catalog-env-rebuild.util), so the administrator's key also sits in the
 * stored auth config, headers or address, where no variable reaches it. The
 * plan below therefore
 *   - empties the connector's own value of every per-user variable,
 *   - puts the fields a catalog adapter builds from them back into their
 *     `{{VAR}}` form,
 *   - and refuses the switch when a per-user variable is used nowhere (a
 *     user's value would change nothing) or its old value is still stored
 *     somewhere as text (it would be sent for everyone).
 * Nothing is written here; the caller stores the plan in one update.
 */

/** A value this long is looked for inside longer strings too (`id:secret` in a header). */
const SUBSTRING_CHECK_MIN_LENGTH = 8;

export interface UserVariableSwitchInput {
  names: readonly string[];
  authType: string;
  envVars: Record<string, string>;
  /** Decrypted. */
  authConfig: Record<string, unknown> | null;
  baseUrl: string;
  headers: Record<string, string> | null;
  config: unknown;
  toolMappings: unknown[];
  /** The catalog adapter the connector was installed from, if any. */
  adapter?: CatalogTemplate | null;
}

export interface UserVariableSwitchPlan {
  envVars: Record<string, string>;
  /** Set when the stored copy changes. */
  authConfig?: Record<string, unknown>;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** The names, checked: a few valid variable names, each once. */
export function checkUserVariableNames(names: unknown): { names: string[] } | { error: string } {
  if (!Array.isArray(names) || names.length === 0) {
    return { error: 'Name at least one variable that every user enters for themselves.' };
  }
  const unique = [...new Set(names)];
  const invalid = unique.filter((name) => !isVariableName(name));
  if (invalid.length > 0) {
    return { error: `Not a variable name: ${invalid.slice(0, 5).map(String).join(', ')}.` };
  }
  if (unique.length > MAX_USER_VARIABLES) {
    return { error: `At most ${MAX_USER_VARIABLES} variables can be per user.` };
  }
  return { names: unique as string[] };
}

function withoutUserVariablesKey(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const { [USER_VARIABLES_CONFIG_KEY]: _names, ...rest } = config as Record<string, unknown>;
  return rest;
}

/**
 * The per-user variables that nothing of the connector refers to as
 * `{{NAME}}`: not its address, headers, auth config or settings, and none of
 * its tools. A user's own value of such a variable is never sent.
 */
export function unreferencedUserVariables(
  names: readonly string[],
  connector: { baseUrl?: unknown; headers?: unknown; authConfig?: unknown; config?: unknown },
  toolMappings: unknown[] = [],
): string[] {
  if (names.length === 0) return [];
  let authConfig = connector.authConfig;
  if (typeof authConfig === 'string') {
    try {
      authConfig = JSON.parse(authConfig);
    } catch {
      authConfig = undefined;
    }
  }
  const referenced = new Set(
    findUnresolvedPlaceholders({
      baseUrl: connector.baseUrl,
      headers: connector.headers,
      authConfig,
      config: withoutUserVariablesKey(connector.config),
      toolMappings,
    }),
  );
  return names.filter((name) => !referenced.has(name));
}

/** `config` keys a per-user variable may appear under: what a call sends, not where it goes. */
const USER_VARIABLE_CONFIG_PATHS: ReadonlyArray<readonly string[]> = [
  ['email', 'fromAddress'],
  ['email', 'fromName'],
  ['mcpFixedArguments'],
];

function withoutPaths(config: unknown, paths: ReadonlyArray<readonly string[]>): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const [head, ...rest] of paths) {
    if (!(head in out)) continue;
    if (rest.length === 0) delete out[head];
    else out[head] = withoutPaths(out[head], [rest]);
  }
  return out;
}

const placeholder = (name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`);

/**
 * A per-user variable in a place that decides WHERE a call goes, or null.
 *
 * Each user's values are their own credential, typed by any member of the
 * workspace. They may fill in a key, a token, a login. They must not choose
 * the server: a call also carries what the connector shares (other headers,
 * a client id, a second secret), and a user who could point it at a host of
 * their own would receive those. So a per-user variable may not sit in the
 * address before its path (scheme, host, port), in the connector's settings
 * (mail hosts and ports, the MCP path, OData settings), or at the start of a
 * tool's path, where a value beginning with https:// replaces the address.
 */
export function userVariablePlacementProblem(
  names: readonly string[],
  connector: { baseUrl?: unknown; config?: unknown; authConfig?: unknown; headers?: unknown },
  toolMappings: unknown[] = [],
): string | null {
  if (names.length === 0) return null;
  const inSignIn = signInPlacementProblem(names, connector);
  if (inSignIn) return inSignIn;
  const baseUrl = typeof connector.baseUrl === 'string' ? connector.baseUrl.trim() : '';
  // Everything up to the first "/", "?" or "#" after the scheme: the server.
  const server = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*/i.exec(baseUrl)?.[0] ?? '';
  for (const name of names) {
    if (placeholder(name).test(server)) {
      return (
        `${name} is part of the connector's address (${server.slice(0, 80)}). The server is the same for every ` +
        'user; only what signs them in can be per user.'
      );
    }
  }
  const settings = withoutPaths(withoutUserVariablesKey(connector.config), USER_VARIABLE_CONFIG_PATHS);
  const inSettings = new Set(findUnresolvedPlaceholders(settings));
  const setting = names.find((name) => inSettings.has(name));
  if (setting) {
    return (
      `${setting} is used in the connector's settings (a host, a port or a path), which are the same for every ` +
      'user; only what signs them in can be per user.'
    );
  }
  for (const mapping of toolMappings) {
    const path = (mapping as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== 'string') continue;
    const atStart = names.find((name) => new RegExp(`^\\s*${placeholder(name).source}`).test(path));
    if (atStart) {
      return (
        `A tool's path starts with {{${atStart}}}, where a value could replace the connector's address. ` +
        'Put the variable after the first "/" of the path.'
      );
    }
  }
  return null;
}

/**
 * Sign-in fields that say how or where to sign in, not with what: the name of
 * the header or parameter a key goes into, where a token is fetched or
 * renewed, which scheme applies. Matched on the last key of the field's path.
 */
const STRUCTURAL_SIGN_IN_KEY =
  /^(headerName|paramName|queryParamName|tokenPlacement|tokenPrefix|tokenProvider|passwordType|grant)$|(url|uri|endpoint|host|hostname|domain|server|issuer|audience)$/i;

function parsedAuthConfig(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Every string in a value with the keys leading to it, and every key itself. */
function leavesAndKeys(
  value: unknown,
  path: string[],
  out: { leaves: Array<{ path: string[]; text: string }>; keys: Array<{ path: string[] }> },
): void {
  if (typeof value === 'string') {
    out.leaves.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => leavesAndKeys(item, [...path, String(index)], out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.keys.push({ path: [...path, key] });
      leavesAndKeys(item, [...path, key], out);
    }
  }
}

/**
 * A per-user variable in the sign-in or the headers where it would be more
 * than a credential: as the name of a header or parameter, in a field that
 * is an address or picks the scheme, anywhere under the token renewal, or as
 * the server of a URL written into a value.
 */
function signInPlacementProblem(
  names: readonly string[],
  connector: { authConfig?: unknown; headers?: unknown },
): string | null {
  for (const [where, value] of [
    ['authConfig', parsedAuthConfig(connector.authConfig)],
    ['headers', connector.headers],
  ] as const) {
    const found = { leaves: [], keys: [] } as Parameters<typeof leavesAndKeys>[2];
    leavesAndKeys(value, [where], found);
    for (const name of names) {
      const uses = placeholder(name);
      const asKey = found.keys.find(({ path }) => uses.test(path[path.length - 1]));
      if (asKey) {
        return `${name} is used as the name of a field (${asKey.path.join('.')}), not as its value. Only a value can be per user.`;
      }
      for (const { path, text } of found.leaves) {
        if (!uses.test(text)) continue;
        const key = path[path.length - 1];
        const structural = STRUCTURAL_SIGN_IN_KEY.test(key) || path.includes('tokenRenewal');
        // A URL written into the value: its server must not come from a user.
        const server = /^\s*[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(text)?.[0];
        if (structural || (server !== undefined && uses.test(server))) {
          return (
            `${name} is used in ${path.join('.')}, which says how or where the connector signs in. That is the ` +
            'same for every user; only the key, token or login itself can be per user.'
          );
        }
      }
    }
  }
  return null;
}

/**
 * Why a connector with per-user variables can no longer take them, or null.
 * The sign-in method is checked when the connector is switched; this is the
 * same check for a connector edited afterwards, before a user's values go
 * anywhere near a sign-in that keeps a session or fetches a token.
 */
export function userVariableEligibilityProblem(connector: {
  type: string;
  authType: string;
  authConfig?: unknown;
  config?: unknown;
  webhookEnabled?: boolean;
}): string | null {
  const parsed = parsedAuthConfig(connector.authConfig);
  const authConfig =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const how = userCredentialModeOf(
    {
      type: connector.type,
      authType: connector.authType,
      authConfig,
      config: connector.config,
      webhookEnabled: connector.webhookEnabled,
      renewsBearerToken: !!withTokenRenewal(connector.authType, authConfig, connector.config, {})?.tokenRenewal,
    },
    // The server switch only stops new switches; this one is already made.
    { variablesEnabled: true },
  );
  if (how.mode === 'variables') return null;
  return how.mode === null
    ? how.reason
    : 'This connector now signs users in through the provider, so their own values of its variables are not used.';
}

/** Every string in a value, with where it is. */
function stringLeaves(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, `${path}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) stringLeaves(item, path ? `${path}.${key}` : key, out);
  }
}

export function planUserVariableSwitch(
  input: UserVariableSwitchInput,
): { plan: UserVariableSwitchPlan } | { error: string } {
  const checked = checkUserVariableNames([...input.names]);
  if ('error' in checked) return checked;
  const names = checked.names;

  const envVars = { ...input.envVars };
  for (const name of names) envVars[name] = '';

  let authConfig = input.authConfig;
  let baseUrl = input.baseUrl;
  let headers = input.headers;
  const plan: UserVariableSwitchPlan = { envVars };
  if (input.adapter) {
    const rebuilt = rebuildCatalogCredentials({
      adapter: input.adapter,
      connectorAuthType: input.authType,
      storedAuthConfig: input.authConfig,
      storedBaseUrl: input.baseUrl,
      storedHeaders: input.headers,
      previousEnvVars: input.envVars,
      nextEnvVars: envVars,
      referenceVariables: names,
    });
    if (rebuilt.authConfig) plan.authConfig = authConfig = rebuilt.authConfig;
    if (rebuilt.baseUrl !== undefined) plan.baseUrl = baseUrl = rebuilt.baseUrl;
    if (rebuilt.headers) plan.headers = headers = rebuilt.headers;
  }

  const unused = unreferencedUserVariables(names, { baseUrl, headers, authConfig, config: input.config }, input.toolMappings);
  if (unused.length > 0) {
    return {
      error:
        `The connector does not use ${unused.map((n) => `{{${n}}}`).join(', ')} anywhere (address, headers, ` +
        'sign-in, tools), so a user\'s own value would never be sent. Write the variable where the credential ' +
        'goes, then switch.',
    };
  }

  const misplaced = userVariablePlacementProblem(
    names,
    { baseUrl, config: input.config, authConfig, headers },
    input.toolMappings,
  );
  if (misplaced) return { error: misplaced };

  const leaves: Array<{ path: string; text: string }> = [];
  stringLeaves(authConfig, 'authConfig', leaves);
  stringLeaves(baseUrl, 'baseUrl', leaves);
  stringLeaves(headers, 'headers', leaves);
  for (const name of names) {
    const old = input.envVars[name];
    if (typeof old !== 'string' || old === '') continue;
    // Also as it reads inside a URL (`p%40ss` for `p@ss`).
    const forms = [...new Set([old, encodeURIComponent(old)])];
    const hit = leaves.find((leaf) =>
      forms.some(
        (form) => leaf.text === form || (form.length >= SUBSTRING_CHECK_MIN_LENGTH && leaf.text.includes(form)),
      ),
    );
    if (hit) {
      return {
        error:
          `The connector's own value of ${name} is still stored in ${hit.path}, where it would be sent for ` +
          `every user. Replace it there with {{${name}}}, then switch.`,
      };
    }
  }
  return { plan };
}
