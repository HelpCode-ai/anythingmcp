import { isSecretName } from '../connectors/connector-secrets.util';
import type { AdapterDefinition } from './catalog';

/**
 * How a connector's variables are presented when someone sets it up: in the
 * guided install, and to a model setting it up through MCP.
 *
 * The catalog only lists variable names (requiredEnvVars / optionalEnvVars).
 * An adapter may add `envVarMeta` to describe them; whatever it leaves out is
 * derived here, so all 265 adapters get a usable form without hand edits.
 */
export type EnvVarKind = 'address' | 'credential' | 'setting';

export interface EnvVarMeta {
  label?: string;
  kind?: EnvVarKind;
  /** Never shown back, never accepted through a chat. */
  secret?: boolean;
  /** Where to find the value, in a sentence. */
  help?: string;
  example?: string;
  /** Regular expression the value must match (validated in the form and in the chat). */
  pattern?: string;
  /** What to tell the user when the value does not match `pattern`. */
  patternMessage?: string;
  /** Page of the provider where the value is created or shown. */
  link?: string;
  /** Rarely needed: shown collapsed (e.g. a refresh token the authorization fills in). */
  advanced?: boolean;
}

export interface EnvVarDescriptor extends Required<Pick<EnvVarMeta, 'label' | 'kind' | 'secret'>> {
  name: string;
  required: boolean;
  help?: string;
  example?: string;
  pattern?: string;
  patternMessage?: string;
  link?: string;
  advanced?: boolean;
}

/**
 * What setting the connector up involves:
 * - `none`: nothing to enter;
 * - `credentials`: values to type or paste;
 * - `oauth_browser`: an app's client settings, then a sign-in at the provider.
 */
export type SetupKind = 'none' | 'credentials' | 'oauth_browser';

const UPPER_WORDS = new Set(['ID', 'URL', 'API', 'DB', 'IP', 'SSL', 'TLS', 'WABA', 'SAP', 'HANA', 'JWT', 'OAUTH']);

/** `ETSY_CLIENT_ID` → "Client ID" (the adapter's own prefix is dropped). */
export function labelFromName(name: string, slug?: string): string {
  let words = name.split(/[_\s]+/).filter(Boolean);
  const prefix = (slug ?? '').toUpperCase().split(/[-_]/)[0];
  if (words.length > 1 && prefix && words[0] === prefix) words = words.slice(1);
  return words
    .map((w) => (UPPER_WORDS.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/** True when the adapter needs a sign-in at the provider (authorization code flow). */
export function needsBrowserAuthorization(adapter: Pick<AdapterDefinition, 'connector'>): boolean {
  const auth = (adapter.connector.authConfig ?? {}) as Record<string, unknown>;
  return (
    adapter.connector.authType === 'OAUTH2' &&
    // An MCP bridge has no authorization URL of its own: the server's OAuth
    // metadata names it when the user clicks "Authorize with Provider".
    (!!auth.authorizationUrl || adapter.connector.type === 'MCP') &&
    String(auth.grant ?? '') !== 'client_credentials'
  );
}

export function setupKind(adapter: Pick<AdapterDefinition, 'connector' | 'requiredEnvVars'>): SetupKind {
  if (needsBrowserAuthorization(adapter)) return 'oauth_browser';
  return adapter.requiredEnvVars.length === 0 ? 'none' : 'credentials';
}

/** Names an authorization fills in: `{{VAR}}` used as the OAuth refresh/access token. */
function tokenVariables(adapter: Pick<AdapterDefinition, 'connector'>): Set<string> {
  const auth = (adapter.connector.authConfig ?? {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ['refreshToken', 'accessToken']) {
    const m = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(String(auth[key] ?? ''));
    if (m) out.add(m[1]);
  }
  return out;
}

export function describeAdapterEnvVars(
  adapter: Pick<
    AdapterDefinition,
    'slug' | 'connector' | 'requiredEnvVars' | 'optionalEnvVars'
  > & { envVarMeta?: Record<string, EnvVarMeta> },
): EnvVarDescriptor[] {
  const browser = needsBrowserAuthorization(adapter);
  const tokens = tokenVariables(adapter);
  const baseUrl = adapter.connector.baseUrl ?? '';
  const names: Array<[string, boolean]> = [
    ...adapter.requiredEnvVars.map((n): [string, boolean] => [n, true]),
    ...(adapter.optionalEnvVars ?? [])
      .filter((n) => !adapter.requiredEnvVars.includes(n))
      .map((n): [string, boolean] => [n, false]),
  ];
  return names.map(([name, required]) => {
    const inAddress = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(baseUrl);
    const secret = isSecretName(name);
    const derived: EnvVarDescriptor = {
      name,
      required,
      label: labelFromName(name, adapter.slug),
      kind: inAddress ? 'address' : secret ? 'credential' : 'setting',
      secret,
      // With a browser sign-in, the token variables are filled by the
      // authorization; asking for them up front only confuses.
      ...(browser && tokens.has(name) ? { advanced: true } : {}),
    };
    const own = adapter.envVarMeta?.[name] ?? {};
    return { ...derived, ...own, name, required } as EnvVarDescriptor;
  });
}
