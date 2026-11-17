import { findSecretLiterals, type FindOptions, type SecretFinding } from '../common/secret-literals.util';
import { SECRET_GUARDED_TYPES } from './secret-extraction.util';

/**
 * A secret written into an HTTP connector's base URL: a Bitrix24, Slack,
 * Discord, Teams, Zapier or Make webhook URL, a Telegram bot token, a
 * `?api_key=` style parameter, a known key shape, or `user:password@`.
 *
 * Saving a connector moves such a secret into an encrypted variable and
 * stores `{{VAR}}` in its place (SecretExtractor). This file covers what was
 * stored before that, or what a save could not move:
 *
 * - the start-up repair (`ConnectorsService.repairBaseUrlSecrets`) moves it,
 *   with these rules;
 * - until then, the API shows the secret as `********` (`toPublicConnector`),
 *   and a form that sends the masked URL back unchanged keeps the stored one.
 *
 * These rules are every rule a save applies except the long-random-token
 * heuristic: a save tells the user what moved, a start-up pass does it
 * silently on every instance, so it only acts on shapes that are certain.
 */
export const BASE_URL_SECRET_RULES: FindOptions = { highEntropy: false };

/** What the API shows in place of a secret in a base URL. */
export const BASE_URL_SECRET_MASK = '********';

/** Connector types whose base URL is an HTTP address (and so is checked). */
export function hasHttpBaseUrl(type: unknown): boolean {
  return typeof type === 'string' && SECRET_GUARDED_TYPES.has(type);
}

/** The secrets in a base URL, by the rules above. */
export function baseUrlSecrets(url: unknown): SecretFinding[] {
  if (typeof url !== 'string' || !url) return [];
  return findSecretLiterals(url, BASE_URL_SECRET_RULES);
}

/** The base URL with every secret replaced by the mask. `{{VAR}}` references stay. */
export function maskBaseUrlSecrets(url: string): string {
  const found = baseUrlSecrets(url);
  let out = url;
  for (const f of [...found].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, f.start)}${BASE_URL_SECRET_MASK}${out.slice(f.end)}`;
  }
  return out;
}

/**
 * Apply an edit made against the masked view. The masked URL sent back as it
 * was shown means "unchanged": the stored URL is kept (and the save then
 * moves its secret into a variable). A URL that still holds the mask but was
 * edited elsewhere cannot be put back together: null, and the caller asks for
 * the full address. Anything else is taken as sent.
 */
export function keepMaskedBaseUrl(incoming: string, stored: string): string | null {
  if (typeof incoming !== 'string' || typeof stored !== 'string') return incoming;
  const masked = maskBaseUrlSecrets(stored);
  if (masked === stored) return incoming;
  if (incoming === masked) return stored;
  return incoming.includes(BASE_URL_SECRET_MASK) ? null : incoming;
}
