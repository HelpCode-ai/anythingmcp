import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Human labels for the `AuthType` enum. The enum name is a database value,
 * not a word anyone reading the dashboard should have to decode, so every
 * surface that shows an auth type goes through here.
 */
const AUTH_TYPE_LABELS: Record<string, string> = {
  NONE: 'Public API',
  API_KEY: 'API Key',
  QUERY_AUTH: 'Query Param Auth',
  BEARER_TOKEN: 'Bearer Token',
  BASIC: 'Basic Auth',
  BASIC_AUTH: 'Basic Auth',
  OAUTH2: 'OAuth 2.0',
  OAUTH1: 'OAuth 1.0a',
  WS_SECURITY: 'WS-Security',
  CERTIFICATE: 'Client Certificate',
  CONNECTION_STRING: 'Connection String',
  HMAC: 'HMAC Signature',
  LOGIN_TOKEN: 'Login Token',
};

export function authTypeLabel(authType: string | null | undefined): string {
  if (!authType) return 'None';
  return AUTH_TYPE_LABELS[authType] ?? authType;
}

/** A variable that holds a credential, judged by its name. */
const SECRET_VARIABLE = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Whether an adapter needs a credential from the user. Some carry the key in
 * the request body (Odoo's JSON-RPC) or a URL, so their authType is NONE
 * although an API key is required: the variables decide too.
 */
export function adapterNeedsCredentials(adapter: {
  authType?: string | null;
  requiredEnvVars?: string[] | null;
}): boolean {
  if (adapter.authType && adapter.authType !== 'NONE') return true;
  return (adapter.requiredEnvVars ?? []).some((v) => SECRET_VARIABLE.test(v));
}

/** The auth chip of a catalog adapter: "API Key" rather than "Public API" when a key is needed. */
export function adapterAuthLabel(adapter: {
  authType?: string | null;
  requiredEnvVars?: string[] | null;
}): string {
  if (adapter.authType === 'NONE' && adapterNeedsCredentials(adapter)) return 'API Key';
  return authTypeLabel(adapter.authType);
}
