import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { getRequiredSecret } from '../secrets.util';

/**
 * At-rest form of a per-user `mcp_` API key.
 *
 * A key is a bearer credential with 256 bits of entropy, so it is stored as a
 * keyed hash, never in plaintext: `HMAC-SHA256(pepper, key)` as hex. The
 * pepper is derived from ENCRYPTION_KEY with HKDF, so a copy of the database
 * alone cannot be used to check guesses, and no extra secret has to be
 * configured (self-hosted instances get it from the key they already have).
 *
 * ENCRYPTION_KEY must never change: changing it would invalidate every stored
 * API key hash, as it already makes stored connector credentials unreadable.
 * The info string versions the derivation; never edit it in place.
 */
const HKDF_INFO = 'amcp:mcp-api-key:v1';

/** Number of trailing characters kept in clear for the masked display. */
export const API_KEY_SUFFIX_LENGTH = 8;

const peppers = new Map<string, Buffer>();

/** HKDF-SHA256 pepper for API key hashes, derived from ENCRYPTION_KEY. */
export function apiKeyPepper(encryptionKey: string = process.env.ENCRYPTION_KEY ?? ''): Buffer {
  const secret = getRequiredSecret('ENCRYPTION_KEY', encryptionKey);
  let pepper = peppers.get(secret);
  if (!pepper) {
    pepper = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
    peppers.set(secret, pepper);
  }
  return pepper;
}

/** The value stored in `mcp_api_keys.key_hash` for a presented key. */
export function hashApiKey(key: string, pepper: Buffer = apiKeyPepper()): string {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

/** The last characters of a key, kept for `mcp_••••<suffix>` in the UI. */
export function apiKeySuffix(key: string): string {
  return key.slice(-API_KEY_SUFFIX_LENGTH);
}

/** Prefix of every key the server issues. Placeholders never start with it. */
export const API_KEY_PREFIX = 'mcp_';

/**
 * Value written to the legacy `mcp_api_keys.key` column instead of the key.
 *
 * The column is still NOT NULL and unique until it is dropped, so each row
 * gets a random, unique, non-secret value. It is not a credential: it never
 * starts with `mcp_`, so it can never match a presented key (see
 * apiKeyLookupWhere). `support` marks support keys (support-keys.ts),
 * `hashed` a user's own key.
 */
export function apiKeyPlaceholder(kind: 'hashed' | 'support' = 'hashed'): string {
  return `${kind}_${randomBytes(24).toString('hex')}`;
}

const PLACEHOLDER = /^(hashed|support)_[0-9a-f]{48}$/;

/** True for a value written by apiKeyPlaceholder(). */
export function isApiKeyPlaceholder(value: string | null | undefined): boolean {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

/**
 * Prisma `where` that finds the key row for a presented key.
 *
 * Rows are matched by hash. Rows created before keys stopped being written to
 * the plaintext column still hold the key there until the one-off clean-up
 * (roles/api-key-placeholders.cli.ts) replaces it, so a presented key is also
 * matched against that column. Only a value shaped like an issued key
 * (`mcp_…`) is compared there: a placeholder never matches. Both columns are
 * unique, so at most one row matches. The plaintext branch is removed when
 * the column is dropped.
 */
export function apiKeyLookupWhere(key: string, pepper: Buffer = apiKeyPepper()) {
  const keyHash = hashApiKey(key, pepper);
  if (!key.startsWith(API_KEY_PREFIX) || isApiKeyPlaceholder(key)) return { keyHash };
  return { OR: [{ keyHash }, { key }] };
}

/** Masked display of a key from its stored suffix: `mcp_••••…<suffix>`. */
export function maskApiKey(suffix: string | null | undefined): string {
  return `${API_KEY_PREFIX}${'•'.repeat(24)}${suffix ?? ''}`;
}
