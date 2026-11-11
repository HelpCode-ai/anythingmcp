/**
 * "Authorize with Provider" for Meta's Instagram connectors: what the flow
 * needs to know, without any I/O.
 *
 * Two flavours, one per catalog adapter:
 *   - `facebook` (adapter `instagram`, graph.facebook.com), in two modes:
 *       - Unified Login (Instagram API with Unified Login), when the app comes
 *         with a Facebook Login for Business configuration id: the login
 *         dialog takes `config_id` instead of `scope`, the user signs in with
 *         Instagram or Facebook and picks the business portfolio and the
 *         Instagram accounts to share, no Facebook Page needed. The code
 *         gives a Business Integration System User token (configured not to
 *         expire), and /me/assigned_instagram_accounts lists the accounts.
 *         Meta apps created since autumn 2026 only offer this mode.
 *       - Classic Facebook Login (older apps, no configuration id): the
 *         `scope` dialog, a Facebook User token exchanged for a long-lived
 *         one, the Instagram account linked to one of the user's Pages.
 *   - `instagram` (adapter `instagram-login`, Instagram API with Instagram
 *     Login): Instagram's own business login, an Instagram User token, no
 *     Facebook Page needed. New Meta apps no longer get this login; apps that
 *     already have it keep it.
 *
 * Both connectors stay BEARER_TOKEN connectors: the flow writes the token it
 * obtains into INSTAGRAM_ACCESS_TOKEN (and the account id into
 * INSTAGRAM_ACCOUNT_ID), exactly where a pasted token goes, and hands the
 * expiry to the bearer token renewal. Pasting a token keeps working.
 *
 * The app: the connector's own (META_APP_ID / META_APP_SECRET, plus
 * META_CONFIG_ID for Unified Login; or INSTAGRAM_APP_ID /
 * INSTAGRAM_APP_SECRET), else, for the `instagram` adapter only, the
 * server's (META_PLATFORM_APP_ID / META_PLATFORM_APP_SECRET /
 * META_PLATFORM_CONFIG_ID), read from the process environment the same way
 * on Cloud and self-hosted. Instagram Login has no server app: new Meta apps
 * cannot get it, so it always takes an app of the user's own.
 */

export type MetaLoginFlavour = 'facebook' | 'instagram';

export interface MetaLoginApp {
  appId: string;
  appSecret: string;
  /**
   * Facebook Login for Business configuration id (Unified Login). Set: the
   * dialog takes it instead of a scope list. Not a secret.
   */
  configId?: string;
}

/** The Graph API version of both flows; the adapters call the same one. */
export const META_LOGIN_GRAPH_VERSION = 'v25.0';
/** The version Meta documents for the Unified Login code exchange and account lookup. */
export const META_UNIFIED_GRAPH_VERSION = 'v27.0';

/** The variables the flow writes on the connector. */
export const META_LOGIN_TOKEN_VAR = 'INSTAGRAM_ACCESS_TOKEN';
export const META_LOGIN_ACCOUNT_VAR = 'INSTAGRAM_ACCOUNT_ID';

interface FlavourSpec {
  /** The catalog adapter this flavour authorizes. */
  adapterSlug: string;
  /** Connector variables of the user's own app. */
  ownAppVars: AppVars;
  /** Server variables of the server's own app; none for Instagram Login (see above). */
  platformAppVars?: AppVars;
  /** The permissions asked for, in the login dialog's `scope`. */
  scopes: readonly string[];
  /** Who the user signs in with, for messages. */
  providerName: string;
}

interface AppVars {
  appId: string;
  appSecret: string;
  /** The Unified Login configuration id (Facebook Login only). */
  configId?: string;
}

const FLAVOURS: Record<MetaLoginFlavour, FlavourSpec> = {
  facebook: {
    adapterSlug: 'instagram',
    ownAppVars: { appId: 'META_APP_ID', appSecret: 'META_APP_SECRET', configId: 'META_CONFIG_ID' },
    platformAppVars: {
      appId: 'META_PLATFORM_APP_ID',
      appSecret: 'META_PLATFORM_APP_SECRET',
      configId: 'META_PLATFORM_CONFIG_ID',
    },
    // Classic Facebook Login only (Unified Login takes its permissions from
    // the configuration). What the connector's tools use. Publishing and
    // deleting are asked for too: those tools are installed switched off,
    // and a permission granted now spares a second sign-in when someone
    // switches them on.
    scopes: [
      'instagram_basic',
      'instagram_manage_insights',
      'instagram_manage_comments',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
    ],
    providerName: 'Facebook',
  },
  instagram: {
    adapterSlug: 'instagram-login',
    ownAppVars: { appId: 'INSTAGRAM_APP_ID', appSecret: 'INSTAGRAM_APP_SECRET' },
    scopes: [
      'instagram_business_basic',
      'instagram_business_manage_insights',
      'instagram_business_manage_comments',
      'instagram_business_content_publish',
      'instagram_business_manage_messages',
    ],
    providerName: 'Instagram',
  },
};

/** The flavour of a catalog adapter, or undefined when it has no Meta login. */
export function metaLoginFlavourOfSlug(slug: unknown): MetaLoginFlavour | undefined {
  if (typeof slug !== 'string') return undefined;
  return (Object.keys(FLAVOURS) as MetaLoginFlavour[]).find((f) => FLAVOURS[f].adapterSlug === slug);
}

/** The flavour of a connector, from the catalog adapter it was installed from. */
export function metaLoginFlavourOf(connector: { config?: unknown }): MetaLoginFlavour | undefined {
  return metaLoginFlavourOfSlug((connector.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug);
}

export function metaLoginScopes(flavour: MetaLoginFlavour): readonly string[] {
  return FLAVOURS[flavour].scopes;
}

export function metaLoginProviderName(flavour: MetaLoginFlavour): string {
  return FLAVOURS[flavour].providerName;
}

export function metaLoginOwnAppVars(flavour: MetaLoginFlavour): AppVars {
  return FLAVOURS[flavour].ownAppVars;
}

export function metaLoginPlatformAppVars(flavour: MetaLoginFlavour): AppVars | undefined {
  return FLAVOURS[flavour].platformAppVars;
}

/** Whether an app signs in with Unified Login (it has a configuration id). */
export function isUnifiedLogin(app: MetaLoginApp | undefined): boolean {
  return !!app?.configId;
}

function appFrom(vars: AppVars, values: Record<string, unknown>): Partial<MetaLoginApp> {
  const configId = vars.configId ? usable(values[vars.configId]) : undefined;
  return {
    appId: usable(values[vars.appId]),
    appSecret: usable(values[vars.appSecret]),
    ...(configId ? { configId } : {}),
  };
}

/** Empty, or a `{{VARIABLE}}` nobody filled in. */
function usable(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !/\{\{/.test(text) ? text : undefined;
}

/**
 * The server's app for a flavour, or undefined when its id or secret is
 * unset, and always for Instagram Login. Read from the process environment,
 * where the config module also loads the .env file.
 */
export function metaLoginPlatformApp(
  flavour: MetaLoginFlavour,
  env: Record<string, string | undefined> = process.env,
): MetaLoginApp | undefined {
  const vars = FLAVOURS[flavour].platformAppVars;
  if (!vars) return undefined;
  const { appId, appSecret, configId } = appFrom(vars, env);
  return appId && appSecret ? { appId, appSecret, ...(configId ? { configId } : {}) } : undefined;
}

/**
 * The app a connector authorizes with: its own when it names an app id, else
 * the server's (not for Instagram Login). `missing` lists the connector
 * variables to fill in when there is neither (or only half of its own).
 */
export function metaLoginAppOf(
  flavour: MetaLoginFlavour,
  envVars: Record<string, unknown> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { app?: MetaLoginApp; usesPlatformApp: boolean; missing: string[] } {
  const vars = FLAVOURS[flavour].ownAppVars;
  const { appId, appSecret, configId } = appFrom(vars, envVars ?? {});
  if (appId && appSecret) {
    return { app: { appId, appSecret, ...(configId ? { configId } : {}) }, usesPlatformApp: false, missing: [] };
  }
  // An app id of its own without its secret is a half-finished own app, not
  // a request for the server's: say what is missing instead of mixing them.
  if (appId || appSecret) {
    return { usesPlatformApp: false, missing: [appId ? vars.appSecret : vars.appId] };
  }
  const platform = metaLoginPlatformApp(flavour, env);
  if (platform) return { app: platform, usesPlatformApp: true, missing: [] };
  return { usesPlatformApp: false, missing: [vars.appId, vars.appSecret] };
}

/** The login dialog the user is sent to. */
export function buildMetaLoginUrl(
  flavour: MetaLoginFlavour,
  app: Pick<MetaLoginApp, 'appId' | 'configId'>,
  redirectUri: string,
  state: string,
): string {
  const appId = app.appId;
  const scope = FLAVOURS[flavour].scopes.join(',');
  if (flavour === 'facebook' && app.configId) {
    // Unified Login: the configuration carries the permissions and assets;
    // `scope` must not be sent. prompt=login shows the Instagram sign-in next
    // to Facebook's even to someone already signed in to Facebook.
    const url = new URL('https://www.facebook.com/dialog/oauth');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('config_id', app.configId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('override_default_response_type', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'login');
    return url.toString();
  }
  if (flavour === 'instagram') {
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    return url.toString();
  }
  const url = new URL(`https://www.facebook.com/${META_LOGIN_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  // Lets someone whose Instagram account is not linked to a Page yet do that
  // inside the dialog (Facebook Login for Business onboarding).
  url.searchParams.set('extras', JSON.stringify({ setup: { channel: 'IG_API_ONBOARDING' } }));
  return url.toString();
}

/** Instagram appends `#_` to the code in some redirects; it is not part of it. */
export function cleanMetaCode(code: string): string {
  return code.trim().replace(/#_?$/, '');
}

/**
 * Whether a connector of a Meta login adapter still waits for its token:
 * nothing usable in INSTAGRAM_ACCESS_TOKEN. Other connectors: false.
 */
export function metaLoginNeedsAuthorization(
  slug: unknown,
  envVars: Record<string, unknown> | null | undefined,
): boolean {
  if (!metaLoginFlavourOfSlug(slug)) return false;
  return !usable((envVars ?? {})[META_LOGIN_TOKEN_VAR]);
}
