import { BadRequestException } from '@nestjs/common';
import type { Connector } from '../generated/prisma/client';
import { getAdapter } from '../adapters/catalog';
import { checkAdapterEnvValues, describeFieldProblems, normalizeAdapterEnvValues } from '../adapters/env-var-checks';
import { resolveDerivedEnvVars, withDerivedValues } from '../adapters/derived-settings';
import { normalizeAddressVariables } from '../common/base-url-variable.util';
import { decrypt } from '../common/crypto/encryption.util';
import { mergeMaskedEnvVars, secretContext } from './connector-secrets.util';
import { describeMissing, rebuildCatalogCredentials } from './catalog-env-rebuild.util';
import { assertConsumerKeyIsNotEmail } from './oauth1-consumer-key.util';

/**
 * Writing a connector's variables, the way PUT /api/connectors/:id/env-vars
 * does it. Kept here so another trusted writer (the WooCommerce one-click key
 * callback) stores keys through exactly the same steps: clean-ups, field
 * checks, derived settings, catalog credentials rebuilt, tools reloaded.
 * Permission checks stay with the caller.
 */

type ConnectorRef = { envVars?: unknown; config?: unknown };

function adapterOf(connector: ConnectorRef) {
  const slug = (connector.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  return typeof slug === 'string' ? getAdapter(slug) : undefined;
}

/**
 * The variable a base URL starts with must hold a whole URL, and a tenant
 * field pasted as the whole address keeps only the label it stands for; the
 * adapter's own clean-ups run first (env-var-checks.ts).
 */
export function normalizeConnectorVariables(
  connector: { baseUrl: string | null; type: string; config?: unknown },
  values: Record<string, string>,
): Record<string, string> {
  const adapter = adapterOf(connector);
  return normalizeAddressVariables(
    adapter ? adapter.connector.baseUrl : connector.baseUrl,
    adapter ? normalizeAdapterEnvValues(adapter, values) : values,
    connector.type,
    { singleLabel: !!adapter },
  );
}

/**
 * Refuse, field by field, a catalog connector variable this edit changes to
 * a value its adapter cannot use (env-var-checks.ts). Only changed values
 * are checked, so a stored value never blocks an unrelated edit; a
 * hand-built connector has no adapter and is not checked.
 */
export function assertCatalogValues(connector: ConnectorRef, next: Record<string, string>): void {
  const adapter = adapterOf(connector);
  if (!adapter) return;
  const stored = (connector.envVars as Record<string, unknown> | null) ?? {};
  const changed = Object.keys(next).filter((name) => next[name] !== stored[name]);
  if (changed.length === 0) return;
  const fields = checkAdapterEnvValues(adapter, next, changed);
  if (Object.keys(fields).length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'invalid_values',
      fields,
      message: describeFieldProblems(fields),
    });
  }
}

/**
 * The variables with the adapter's derived settings (derived-settings.ts)
 * looked up again for each source this edit changes: Atlassian's cloudId
 * when the site changes, removed when the site is cleared. A site that
 * answers without one is refused on its field, as in the setup form.
 */
export async function withDerivedSettings(
  connector: ConnectorRef,
  next: Record<string, string>,
): Promise<Record<string, string>> {
  const adapter = adapterOf(connector);
  if (!adapter?.derivedEnvVars) return next;
  const stored = (connector.envVars as Record<string, unknown> | null) ?? {};
  const changed = Object.keys({ ...stored, ...next }).filter((name) => next[name] !== stored[name]);
  if (changed.length === 0) return next;
  const derived = await resolveDerivedEnvVars(adapter, next, { only: changed });
  if (Object.keys(derived.fields).length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'invalid_values',
      fields: derived.fields,
      message: describeFieldProblems(derived.fields),
    });
  }
  return (withDerivedValues(next, derived) ?? {}) as Record<string, string>;
}

/** The stored authConfig, or null when there is none or it cannot be read. */
export function readStoredAuthConfig(authConfig: string | null, encryptionKey: string): Record<string, unknown> | null {
  if (!authConfig) return null;
  try {
    const cfg = JSON.parse(decrypt(authConfig, encryptionKey));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch {
    return null;
  }
}

export interface EnvVarWriteDeps {
  connectorsService: { update(id: string, data: any): Promise<Connector> };
  mcpServer: { reloadConnectorTools(id: string): Promise<unknown> };
  encryptionKey: string;
}

/**
 * Store `incoming` as the connector's variables (the whole map: a name left
 * out is removed, a masked secret sent back empty keeps its stored value) and
 * rebuild what a catalog connector resolved from them. Returns the updated
 * connector and the warnings to show.
 */
export async function writeConnectorEnvVars(
  deps: EnvVarWriteDeps,
  connector: Connector,
  incoming: Record<string, unknown>,
): Promise<{ updated: Connector; warnings: string[] }> {
  // Trim pasted values: a stray leading/trailing space would be stored (and
  // encrypted into authConfig below) verbatim and break auth with an error
  // the UI can't explain, since the displayed value looks correct. Rebuilt
  // via Object.fromEntries (no dynamic user-keyed property write).
  const trimmed: Record<string, string> = Object.fromEntries(
    Object.entries(incoming || {}).map(([k, v]) => [k.trim(), typeof v === 'string' ? v.trim() : (v as string)]),
  );

  const adapter = adapterOf(connector);
  const stored = (connector.envVars as Record<string, string> | null) || {};

  // The editor never receives stored secrets, so it sends them back empty
  // when they were not retyped: keep the stored value for those.
  const kept = mergeMaskedEnvVars(trimmed, stored, secretContext(connector));

  // The variable a base URL starts with (`{{SUBSTACK_PUBLICATION_URL}}`)
  // must hold a whole URL: add the missing https:// to a bare host, refuse
  // anything else with the variable's name. Catalog connectors store the
  // resolved URL, so the template comes from the catalog; a hand-built
  // connector keeps its template as the base URL itself.
  // A tenant field (`{{FRESHDESK_DOMAIN}}.freshdesk.com`) pasted as the
  // whole address keeps only the label it stands for, as at install;
  // without it the edit stored `acme.freshdesk.com/api/v2.freshdesk.com/…`.
  const normalized = normalizeConnectorVariables(connector, kept);
  // The same field checks as the install form: this editor used to store
  // what the form would have refused (an Odoo address with /web after the
  // host, a CRM page where the Bitrix24 webhook URL goes).
  assertCatalogValues(connector, normalized);
  // Settings looked up from a changed value (Atlassian's cloudId when the
  // site changes) are stored, or dropped, with it.
  const envVars = await withDerivedSettings(connector, normalized);

  const updateData: {
    envVars: Record<string, string>;
    authConfig?: Record<string, unknown>;
    baseUrl?: string;
    headers?: Record<string, string>;
  } = { envVars };
  const warnings: string[] = [];

  // For catalog-installed connectors, authConfig/baseUrl/headers were
  // resolved from the adapter template at import time and frozen (auth
  // encrypted). Re-resolve the fields that use a changed variable, so
  // editing a variable changes the credentials used for requests, and leave
  // the rest — a key corrected in the auth editor, issued OAuth tokens, a
  // custom header — as stored. See catalog-env-rebuild.util.ts.
  if (adapter) {
    const rebuilt = rebuildCatalogCredentials({
      adapter,
      connectorAuthType: connector.authType,
      storedAuthConfig: readStoredAuthConfig(connector.authConfig, deps.encryptionKey),
      storedBaseUrl: connector.baseUrl,
      storedHeaders: (connector.headers as Record<string, string> | null) ?? null,
      previousEnvVars: stored,
      nextEnvVars: envVars,
    });
    if (rebuilt.authConfig) {
      const consumerKey = rebuilt.authConfig.consumerKey;
      if (connector.authType === 'OAUTH1' && typeof consumerKey === 'string') {
        assertConsumerKeyIsNotEmail(consumerKey, rebuilt.authFieldVariables.consumerKey?.join(', '));
      }
      updateData.authConfig = rebuilt.authConfig;
    }
    if (rebuilt.baseUrl !== undefined) updateData.baseUrl = rebuilt.baseUrl;
    if (rebuilt.headers) updateData.headers = rebuilt.headers;
    for (const { variable, from } of rebuilt.aliasesUsed) {
      warnings.push(
        `${variable} is not set; used ${from}, its name in earlier versions ` +
          `of this connector. Rename ${from} to ${variable} to silence this.`,
      );
    }
    warnings.push(...describeMissing(rebuilt.missing));
  }

  const updated = await deps.connectorsService.update(connector.id, updateData);
  await deps.mcpServer.reloadConnectorTools(connector.id);
  return { updated, warnings };
}
