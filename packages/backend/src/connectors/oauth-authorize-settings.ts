import { interpolateDeep } from '../common/env-interpolation.util';
import { findUnresolvedPlaceholders } from '../common/unresolved-placeholders.util';
import {
  clientAssertionSettingsFrom,
  isPrivateKeyJwt,
  type ClientAssertionSettings,
} from './engines/client-assertion.util';

/**
 * What the "Authorize with Provider" flow of a REST/GraphQL connector needs,
 * worked out from the connector's stored authConfig.
 *
 * Two things the stored config alone does not give:
 *
 * 1. Placeholders. A connector installed before its credentials were typed
 *    keeps `{{ETSY_CLIENT_ID}}` in authConfig and the value in envVars; the
 *    tool path resolves them at call time, and this flow has to as well, or
 *    the provider is sent `client_id={{ETSY_CLIENT_ID}}`.
 *
 * 2. Endpoints the catalog added later. authConfig is copied into the row at
 *    install and the catalog re-sync never touches it, so a connector
 *    installed before its adapter gained an `authorizationUrl` has none and
 *    the button could only answer "No authorization URL configured". When the
 *    row has none, the catalog adapter it was installed from supplies the
 *    authorization URL (and the scopes / token URL / token auth method, each
 *    only if the row lacks it). Nothing is written at this point: the stored
 *    config is untouched unless and until the user completes the flow.
 *
 * Values that the row already has always win over the catalog's.
 */
export interface RestAuthorizeSettings {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope?: string;
  tokenAuthMethod?: string;
  /** private_key_jwt only: how to sign the client assertion (resolved). */
  clientAssertion?: ClientAssertionSettings;
  /**
   * Settings taken from the catalog because the row lacked them, to be
   * written to the row's authConfig once the authorization succeeds, so the
   * OAuth settings form shows what was used and a later re-authorization
   * does not depend on the catalog.
   */
  adopted: Record<string, string>;
  /** `{{VAR}}` names in the client id/secret that no env var fills. */
  missingVars: string[];
}

const ADOPTABLE = [
  'authorizationUrl',
  'scopes',
  'tokenUrl',
  'tokenAuthMethod',
] as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

export function resolveRestAuthorizeSettings(
  storedAuthConfig: Record<string, unknown>,
  envVars: Record<string, string> | null | undefined,
  catalogAuthConfig?: Record<string, unknown> | null,
): RestAuthorizeSettings {
  const cfg = interpolateDeep(storedAuthConfig, envVars ?? {});

  const adopted: Record<string, string> = {};
  // Only when the row has no authorization URL of its own: a row that has
  // one was configured by someone (install or the OAuth settings form), and
  // mixing its endpoints with the catalog's would be a guess.
  if (!str(cfg.authorizationUrl) && catalogAuthConfig) {
    for (const key of ADOPTABLE) {
      const fromCatalog = str(catalogAuthConfig[key]);
      // A catalog value with a placeholder (a tenant in the host, say) would
      // need the install-time credentials to resolve; leave those alone.
      if (
        fromCatalog &&
        !str(cfg[key]) &&
        findUnresolvedPlaceholders(fromCatalog).length === 0
      ) {
        adopted[key] = fromCatalog;
      }
    }
  }

  const merged = { ...cfg, ...adopted };
  const clientId = str(merged.clientId) ?? '';
  const clientSecret = str(merged.clientSecret);
  const tokenUrl = str(merged.tokenUrl) ?? '';
  const tokenAuthMethod = str(merged.tokenAuthMethod);

  // private_key_jwt signs with a key instead of sending a secret, so the key
  // and the claims (Revolut's `iss` is the redirect domain) are what has to
  // be set before the provider can be asked for consent.
  const clientAssertion = isPrivateKeyJwt(tokenAuthMethod)
    ? clientAssertionSettingsFrom(merged, tokenUrl)
    : undefined;

  return {
    clientId,
    clientSecret,
    authorizationUrl: str(merged.authorizationUrl) ?? '',
    tokenUrl,
    scope: str(merged.scopes),
    tokenAuthMethod,
    clientAssertion,
    adopted,
    missingVars: findUnresolvedPlaceholders(
      clientAssertion
        ? [clientId, clientAssertion.privateKey, clientAssertion.claims ?? {}]
        : [clientId, clientSecret ?? ''],
    ),
  };
}
