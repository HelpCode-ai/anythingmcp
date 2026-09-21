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
